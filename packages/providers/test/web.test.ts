import { describe, expect, it } from "vitest";
import {
  analyzeSite,
  assertPublicUrl,
  isPrivateAddress,
  parseHtml,
  readPage,
  robotsAllows,
  safeFetch,
  WebsiteConnector,
} from "../src/index.js";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const html = (body: string, extra: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...extra },
  });

describe("safe fetching", () => {
  it("knows private and reserved addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses internal hosts, other schemes, ports and credentials", async () => {
    const internal = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(assertPublicUrl("http://intranet.example/", internal)).rejects.toThrow(/داخلي/);
    await expect(
      assertPublicUrl("http://169.254.169.254/latest/meta-data", publicDns),
    ).rejects.toThrow(/داخلي/);
    await expect(assertPublicUrl("http://localhost:3000/", publicDns)).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd", publicDns)).rejects.toThrow(/http/);
    await expect(assertPublicUrl("https://example.com:8443/", publicDns)).rejects.toThrow(/منفذ/);
    await expect(assertPublicUrl("https://u:p@example.com/", publicDns)).rejects.toThrow();
    await expect(assertPublicUrl("https://example.com/", publicDns)).resolves.toBeInstanceOf(URL);
  });

  it("checks every redirect hop", async () => {
    const lookup = async (host: string) =>
      host === "evil.example"
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }];
    const fetch = async () =>
      new Response(null, { status: 302, headers: { location: "http://evil.example/admin" } });
    await expect(safeFetch("https://ok.example/", { fetch, lookup })).rejects.toThrow(/داخلي/);
  });

  it("stops at the size limit and refuses binary files", async () => {
    const big = "x".repeat(5000);
    const r = await safeFetch("https://ok.example/", {
      fetch: async () => html(big),
      lookup: publicDns,
      maxBytes: 1000,
    });
    expect(r.body.length).toBeLessThanOrEqual(5000);
    await expect(
      safeFetch("https://ok.example/f.zip", {
        fetch: async () => new Response("PK", { headers: { "content-type": "application/zip" } }),
        lookup: publicDns,
      }),
    ).rejects.toThrow(/نصية/);
  });

  it("reads robots.txt rules for every agent", () => {
    const robots =
      "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/ok\n";
    expect(robotsAllows(robots, "/")).toBe(true);
    expect(robotsAllows(robots, "/private/x")).toBe(false);
    expect(robotsAllows(robots, "/private/ok/1")).toBe(true);
    expect(robotsAllows("", "/x")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /\n", "/anything")).toBe(false);
  });
});

describe("reading pages and sites", () => {
  const site: Record<string, string> = {
    "/robots.txt": "User-agent: *\nDisallow: /secret\n",
    "/": `<html lang="ar"><head><title>Acme FX &amp; Partners</title><meta name="description" content="وسيط تداول"></head>
      <body><script>var x=1</script><nav><a href="/contact">تواصل معنا</a> <a href="/partners">برنامج الشركاء</a> <a href="/secret">s</a></nav>
      <p>Regulated by the Dubai Financial Services Authority (DFSA).</p>
      <a href="https://www.instagram.com/acmefx/">ig</a> <a href="https://t.me/acmefx">tg</a></body></html>`,
    "/contact": `<p>البريد: sales@acme-fx.com</p><a href="tel:+971501234567">اتصل</a><a href="mailto:ib@acme-fx.com">ib</a>`,
    "/partners": `<h1>Introducing Broker program</h1><a href="https://www.youtube.com/@acmefx">yt</a>`,
  };
  const fetch = async (url: string) => {
    const path = new URL(url).pathname;
    return site[path] !== undefined
      ? html(site[path] as string)
      : new Response("no", { status: 404 });
  };

  it("parses HTML into text, links and meta", () => {
    const p = parseHtml(site["/"] as string, "https://acme-fx.com/");
    expect(p.title).toBe("Acme FX & Partners");
    expect(p.description).toBe("وسيط تداول");
    expect(p.lang).toBe("ar");
    expect(p.text).not.toContain("var x");
    expect(p.links.find((l) => l.text === "تواصل معنا")?.href).toBe("https://acme-fx.com/contact");
  });

  it("reads a page and refuses what robots.txt disallows", async () => {
    const r = await readPage("acme-fx.com/contact", { fetch, lookup: publicDns });
    expect(r.emails.sort()).toEqual(["ib@acme-fx.com", "sales@acme-fx.com"]);
    expect(r.phones).toEqual(["+971501234567"]);
    await expect(
      readPage("https://acme-fx.com/secret", { fetch, lookup: publicDns }),
    ).rejects.toThrow(/robots/);
  });

  it("analyses a site across its contact and partner pages", async () => {
    const s = await analyzeSite("acme-fx.com", { fetch, lookup: publicDns });
    expect(s.pages).toHaveLength(3);
    expect(s.regulators).toEqual(["DFSA"]);
    expect(s.partnerProgram).toBe(true);
    expect(s.accounts.map((a) => `${a.platform}:${a.handle}`).sort()).toEqual([
      "instagram:acmefx",
      "telegram:acmefx",
      "youtube:acmefx",
    ]);
    const acc = await new WebsiteConnector({ fetch, lookup: publicDns }).getAccount("acme-fx.com");
    expect(acc).toMatchObject({
      displayName: "Acme FX & Partners",
      stats: { partnerProgram: true, regulators: ["DFSA"] },
    });
    expect(acc.links).toContain("https://t.me/acmefx");
  });
});
