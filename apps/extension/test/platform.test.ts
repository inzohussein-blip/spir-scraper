import { describe, expect, it } from "vitest";
import { JOB_MAX, Platform } from "../src/platform.js";
import { normalizeSite, originPatterns, siteAllowed } from "../src/settings.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Platform", () => {
  it("saves usernames as jobs of at most 1000, cleaned and de-duplicated", async () => {
    const bodies: any[] = [];
    const p = new Platform("https://x.app/", "sk_1", async (url, init) => {
      expect(url).toBe("https://x.app/api/v1/jobs");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_1");
      bodies.push(JSON.parse(String(init?.body)));
      return json({ job: { id: `j${bodies.length}` } }, 202);
    });
    const names = Array.from({ length: 1500 }, (_, i) => `user${i}`);
    const r = await p.save("proj", ["@User0", "bad name!", ...names]);
    expect(r).toEqual({ jobIds: ["j1", "j2"], count: 1500 });
    expect(bodies[0].usernames).toHaveLength(JOB_MAX);
    expect(bodies[1]).toMatchObject({ projectId: "proj", limit: 500 });
  });

  it("returns null for accounts not collected and explains a wrong key", async () => {
    const p = new Platform("https://x.app", "k", async (url) =>
      url.endsWith("/profiles/ghost")
        ? json({ error: "Profile not collected" }, 404)
        : json({}, 401),
    );
    expect(await p.lookup("@Ghost")).toBeNull();
    await expect(p.projects()).rejects.toThrow("مفتاح المنصة");
    await expect(new Platform("", "").projects()).rejects.toThrow("اربط المنصة");
  });
});

describe("allowed sites", () => {
  it("matches the site and its subdomains only", () => {
    expect(siteAllowed("https://www.instagram.com/x/", ["instagram.com"])).toBe(true);
    expect(siteAllowed("https://instagram.com.evil.io/", ["instagram.com"])).toBe(false);
    expect(siteAllowed("chrome://settings", ["instagram.com"])).toBe(false);
    expect(normalizeSite("https://WWW.Instagram.com/p/1")).toBe("instagram.com");
    expect(originPatterns(["example.com"])).toEqual([
      "https://example.com/*",
      "https://*.example.com/*",
    ]);
  });
});
