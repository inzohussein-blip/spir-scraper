import { describe, expect, it } from "vitest";
import {
  contactsFromLinkPageHtml,
  createMxChecker,
  extractContact,
  fetchLinkPage,
  isLinkPage,
  profileQuality,
  resolveContact,
} from "../src/extract/index.js";
import type { RawProfile } from "../src/types.js";

const biz = (over: Partial<RawProfile> = {}): RawProfile => ({
  igUserId: "1",
  username: "a",
  isBusiness: true,
  isVerified: false,
  ...over,
});
const err = (code: string) => Object.assign(new Error(code), { code });

describe("extra contact fields", () => {
  it("uses the WhatsApp contact option and infers country from the city", () => {
    expect(extractContact(biz({ businessWhatsapp: "0501234567", city: "الرياض" }))).toMatchObject({
      phoneE164: "+966501234567",
      phoneCountry: "SA",
      contactSource: "business_button",
    });
  });
});

describe("profileQuality", () => {
  const posts = (n: number, likes: number) =>
    Array.from({ length: n }, () => ({ likes, comments: 0 }));
  it("computes engagement and flags low engagement", () => {
    expect(profileQuality({ followers: 10_000, recentPosts: posts(6, 500) })).toEqual({
      engagementRate: 5,
      flags: [],
    });
    expect(profileQuality({ followers: 100_000, recentPosts: posts(6, 100) }).flags).toEqual([
      "low_engagement",
    ]);
    expect(profileQuality({ followers: 2000, recentPosts: posts(5, 1000) }).flags).toEqual([
      "suspicious_engagement",
    ]);
  });
  it("flags follow farming and near-empty accounts, and needs 3 posts for a rate", () => {
    expect(profileQuality({ followers: 300, following: 4000, posts: 1 })).toEqual({
      engagementRate: null,
      flags: ["follow_farming", "few_posts"],
    });
    expect(profileQuality({ followers: 100, recentPosts: posts(2, 10) }).engagementRate).toBeNull();
  });
});

describe("link-in-bio pages", () => {
  it("recognises only allowed hosts over https", () => {
    expect(isLinkPage("https://linktr.ee/acme")).toBe(true);
    expect(isLinkPage("linktr.ee/acme")).toBe(true);
    expect(isLinkPage("https://linktr.ee/")).toBe(false);
    expect(isLinkPage("http://linktr.ee/acme")).toBe(false);
    expect(isLinkPage("https://evil.com/linktr.ee")).toBe(false);
    expect(isLinkPage(null)).toBe(false);
  });

  it("extracts mailto, text emails and WhatsApp links from HTML", () => {
    const html = `<a href="mailto:Sales@Acme.com?subject=hi">mail</a><p>or info [at] acme [dot] io</p>
      <a href="https://wa.me/966501234567">WhatsApp</a><script>var x="ignored@track.er"</script>`;
    const c = contactsFromLinkPageHtml(html);
    expect(c.emails.sort()).toEqual(["info@acme.io", "sales@acme.com"]);
    expect(c.phoneText).toBe("+966501234567");
  });

  it("fetches with a size cap and follows redirects only to allowed hosts", async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/start"))
        return new Response(null, {
          status: 301,
          headers: { location: "https://linktr.ee/final" },
        });
      if (url.endsWith("/away"))
        return new Response(null, { status: 302, headers: { location: "https://evil.com/x" } });
      return new Response('<a href="mailto:a@b.co">x</a>');
    };
    expect(await fetchLinkPage("https://linktr.ee/start", fake)).toEqual({
      emails: ["a@b.co"],
      phoneText: "",
    });
    expect(calls).toEqual(["https://linktr.ee/start", "https://linktr.ee/final"]);
    expect(await fetchLinkPage("https://linktr.ee/away", fake)).toBeNull();
    expect(await fetchLinkPage("https://example.com/x", fake)).toBeNull();
    expect(
      await fetchLinkPage("https://linktr.ee/x", async () => new Response("", { status: 404 })),
    ).toBeNull();
  });
});

describe("createMxChecker", () => {
  it("accepts MX or A records, rejects missing domains, and caches per domain", async () => {
    let lookups = 0;
    const check = createMxChecker({
      resolver: {
        resolveMx: async (d) => {
          lookups++;
          if (d === "gmail.com") return [{ exchange: "mx", priority: 1 }];
          if (d === "a-only.com") throw err("ENODATA");
          if (d === "slow.com") return new Promise(() => {});
          throw err(d === "flaky.com" ? "ECONNREFUSED" : "ENOTFOUND");
        },
        resolve4: async (d) => {
          if (d === "a-only.com") return ["1.2.3.4"];
          throw err("ENOTFOUND");
        },
      },
      timeoutMs: 50,
    });
    expect(await check("x@gmail.com")).toBe("valid");
    expect(await check("y@gmail.com")).toBe("valid");
    expect(lookups).toBe(1);
    expect(await check("x@a-only.com")).toBe("valid");
    expect(await check("x@no-such-domain.zz")).toBe("invalid");
    expect(await check("x@flaky.com")).toBe("unknown");
    expect(await check("x@slow.com")).toBe("unknown");
    expect(await check("nodomain")).toBe("invalid");
  });
});

describe("resolveContact", () => {
  it("reads the link page only when nothing else was found", async () => {
    let fetched = 0;
    const linkPage = async () => {
      fetched++;
      return { emails: ["hi@shop.com"], phoneText: "+201001234567" };
    };
    const r = await resolveContact(biz({ externalUrl: "https://linktr.ee/shop" }), { linkPage });
    expect(r).toMatchObject({
      email: "hi@shop.com",
      phoneE164: "+201001234567",
      contactSource: "link",
    });
    await resolveContact(biz({ bio: "me@shop.com", externalUrl: "https://linktr.ee/shop" }), {
      linkPage,
    });
    await resolveContact(biz({ isBusiness: false, externalUrl: "https://linktr.ee/shop" }), {
      linkPage,
    });
    expect(fetched).toBe(1);
  });

  it("drops emails whose domain cannot receive mail", async () => {
    const checkEmail = async (e: string) =>
      (e.endsWith("@fake.zz") ? "invalid" : "valid") as "invalid" | "valid";
    expect(await resolveContact(biz({ bio: "x@fake.zz" }), { checkEmail })).toMatchObject({
      email: null,
      emailRejected: "x@fake.zz",
      contactSource: null,
    });
    expect(
      await resolveContact(biz({ bio: "x@fake.zz +966501234567" }), { checkEmail }),
    ).toMatchObject({
      email: null,
      phoneE164: "+966501234567",
      contactSource: "bio",
    });
    expect((await resolveContact(biz({ bio: "x@ok.com" }), { checkEmail })).email).toBe("x@ok.com");
  });

  it("survives a failing link page", async () => {
    const r = await resolveContact(biz({ externalUrl: "https://linktr.ee/x" }), {
      linkPage: async () => {
        throw new Error("down");
      },
    });
    expect(r.contactSource).toBeNull();
  });
});
