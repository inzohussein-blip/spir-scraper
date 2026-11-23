import { BlockedError, BudgetExceededError, NotFoundError, RateLimitedError } from "@scrapers/core";
import { describe, expect, it } from "vitest";
import { ApifyProvider, mapApifyProfile, providersFromEnv, WorkerProvider } from "../src/index.js";

type Call = { url: string; init?: RequestInit | undefined };

function fakeFetch(routes: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return routes(url, init);
  };
  return { fn, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("WorkerProvider", () => {
  it("fetches a profile with the shared secret", async () => {
    const f = fakeFetch(() =>
      json({ igUserId: "1", username: "a", isBusiness: true, isVerified: false }),
    );
    const p = new WorkerProvider({ url: "http://w:8000/", sharedSecret: "s", fetch: f.fn });
    await expect(p.getProfile("a.b")).resolves.toMatchObject({ username: "a" });
    expect(f.calls[0]?.url).toBe("http://w:8000/profile/a.b");
    expect(f.calls[0]?.init?.headers).toMatchObject({ "x-worker-secret": "s" });
    expect(p.ratePerMinute).toBe(20);
  });

  it.each([
    [404, NotFoundError],
    [429, RateLimitedError],
    [403, BlockedError],
    [401, BlockedError],
  ])("maps HTTP %i", async (status, Err) => {
    const p = new WorkerProvider({
      url: "http://w",
      sharedSecret: "s",
      fetch: fakeFetch(() => json({}, status)).fn,
    });
    await expect(p.getProfile("a")).rejects.toBeInstanceOf(Err);
  });

  it("reports other failures", async () => {
    const p = new WorkerProvider({
      url: "http://w",
      sharedSecret: "s",
      fetch: fakeFetch(() => new Response("oops", { status: 500 })).fn,
    });
    await expect(p.getProfile("a")).rejects.toThrow(/HTTP 500 oops/);
  });
});

describe("mapApifyProfile", () => {
  it("maps the documented field names", () => {
    expect(
      mapApifyProfile({
        id: "42",
        username: "Acme",
        fullName: "Acme FX",
        biography: "bio",
        followersCount: 1200,
        followsCount: 3,
        postsCount: 9,
        isBusinessAccount: true,
        verified: false,
        businessCategoryName: "Finance",
        externalUrl: "https://acme.com",
        publicEmail: "a@acme.com",
        publicPhoneNumber: "501234567",
        publicPhoneCountryCode: "966",
      }),
    ).toEqual({
      igUserId: "42",
      username: "acme",
      fullName: "Acme FX",
      bio: "bio",
      followers: 1200,
      following: 3,
      posts: 9,
      isBusiness: true,
      isVerified: false,
      category: "Finance",
      externalUrl: "https://acme.com",
      businessEmail: "a@acme.com",
      businessPhone: "501234567",
      businessPhoneCountryCode: "966",
      businessWhatsapp: null,
      city: null,
      recentPosts: null,
    });
  });

  it("maps WhatsApp, city and recent posts", () => {
    expect(
      mapApifyProfile({
        username: "x",
        whatsappNumber: "+9647701234567",
        cityName: "Baghdad",
        latestPosts: [{ likesCount: 10, commentsCount: 2 }, {}],
      }),
    ).toMatchObject({
      businessWhatsapp: "+9647701234567",
      city: "Baghdad",
      recentPosts: [
        { likes: 10, comments: 2 },
        { likes: null, comments: null },
      ],
    });
  });

  it("tolerates missing fields and rejects items without a username", () => {
    expect(mapApifyProfile({ username: "x" })).toMatchObject({
      igUserId: "x",
      isBusiness: false,
      bio: null,
    });
    expect(() => mapApifyProfile({})).toThrow(/no username/);
  });
});

describe("ApifyProvider", () => {
  const limits = (limit: number, used: number) =>
    json({ data: { limits: { maxMonthlyUsageUsd: limit }, current: { monthlyUsageUsd: used } } });

  it("caps runs to the remaining free credit", async () => {
    const f = fakeFetch((url) =>
      url.includes("/limits")
        ? limits(5, 1.5)
        : json([{ username: "acme", isBusinessAccount: true }]),
    );
    const p = new ApifyProvider({ token: "t", fetch: f.fn });
    await expect(p.getProfile("acme")).resolves.toMatchObject({
      username: "acme",
      isBusiness: true,
    });
    const run = f.calls[1];
    expect(run?.url).toContain("/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items");
    expect(run?.url).toContain("maxTotalChargeUsd=3.50");
    expect(JSON.parse(String(run?.init?.body))).toEqual({ usernames: ["acme"] });
  });

  it("applies a cap below the account limit, never above it", async () => {
    const budget = (cap: number, limit: number, used: number) =>
      new ApifyProvider({
        token: "t",
        monthlyCapUsd: cap,
        fetch: fakeFetch(() => limits(limit, used)).fn,
      }).remainingBudgetUsd();
    await expect(budget(3, 5, 1)).resolves.toBe(2);
    await expect(budget(10, 5, 1)).resolves.toBe(4);
    await expect(budget(0, 5, 1)).resolves.toBe(4);
    await expect(budget(0, 5, 6)).resolves.toBe(0);
  });

  it("reports this month's spend against what is allowed (for the spend meter)", async () => {
    const p = new ApifyProvider({
      token: "t",
      monthlyCapUsd: 3,
      fetch: fakeFetch(() => limits(5, 1.25)).fn,
    });
    await expect(p.usage()).resolves.toEqual({ usedUsd: 1.25, allowedUsd: 3 });
  });

  it("refuses to run once the credit is used up", async () => {
    const p = new ApifyProvider({ token: "t", fetch: fakeFetch(() => limits(5, 5)).fn });
    await expect(p.getProfile("a")).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("maps 402 to a budget error and empty results to an error", async () => {
    const f402 = fakeFetch((url) => (url.includes("/limits") ? limits(5, 0) : json({}, 402)));
    await expect(
      new ApifyProvider({ token: "t", fetch: f402.fn }).getProfile("a"),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    const empty = fakeFetch((url) => (url.includes("/limits") ? limits(5, 0) : json([])));
    await expect(
      new ApifyProvider({ token: "t", fetch: empty.fn }).getProfile("a"),
    ).rejects.toThrow(/no profile/);
  });

  it("discovers commenters on a competitor's recent posts", async () => {
    const f = fakeFetch((url) => {
      if (url.includes("/limits")) return limits(5, 0);
      if (url.includes("post-scraper"))
        return json([{ url: "https://instagram.com/p/A/" }, { url: "https://instagram.com/p/B/" }]);
      return json([
        { ownerUsername: "Fan1" },
        { ownerUsername: "competitor" },
        { owner: { username: "fan2" } },
        { error: "x" },
      ]);
    });
    const p = new ApifyProvider({ token: "t", fetch: f.fn });
    const out: string[] = [];
    for await (const u of p.listEngagers({ type: "profile", username: "competitor", url: "u" }, 10))
      out.push(u);
    expect(out).toEqual(["fan1", "fan2"]);
    expect(JSON.parse(String(f.calls[3]?.init?.body))).toEqual({
      directUrls: ["https://instagram.com/p/A/", "https://instagram.com/p/B/"],
      resultsLimit: 5,
    });
  });

  it("discovers hashtag posters and post commenters", async () => {
    const f = fakeFetch((url) =>
      url.includes("/limits") ? limits(5, 0) : json([{ ownerUsername: "a" }]),
    );
    const p = new ApifyProvider({ token: "t", fetch: f.fn });
    const collect = async (it: AsyncIterable<string>) => {
      const o: string[] = [];
      for await (const u of it) o.push(u);
      return o;
    };
    expect(await collect(p.listEngagers({ type: "hashtag", tag: "fx", url: "u" }, 3))).toEqual([
      "a",
    ]);
    expect(
      await collect(
        p.listEngagers({ type: "post", shortcode: "X", url: "https://instagram.com/p/X/" }, 3),
      ),
    ).toEqual(["a"]);
  });

  it("reads commenters from the competitor's 20 most recent posts by default", async () => {
    const f = fakeFetch((url) => (url.includes("/limits") ? limits(5, 0) : json([])));
    const p = new ApifyProvider({ token: "t", fetch: f.fn });
    for await (const _ of p.listEngagers({ type: "profile", username: "c", url: "u" }, 10)) {
    }
    const posts = f.calls.find((c) => c.url.includes("post-scraper"));
    expect(JSON.parse(String(posts?.init?.body))).toEqual({ username: ["c"], resultsLimit: 20 });
  });

  it("collects an account's followers with Apify's followers actor", async () => {
    const f = fakeFetch((url) =>
      url.includes("/limits")
        ? limits(5, 0)
        : json([{ username: "Follower1" }, { username: "competitor" }, { username: "f2" }]),
    );
    const p = new ApifyProvider({ token: "t", fetch: f.fn });
    const out: string[] = [];
    for await (const u of p.listEngagers(
      { type: "followers", username: "competitor", url: "u" },
      50,
    ))
      out.push(u);
    expect(out).toEqual(["follower1", "f2"]);
    const run = f.calls.find((c) => c.url.includes("/acts/"));
    expect(run?.url).toContain("/acts/apify~instagram-followers-following-scraper/");
    expect(JSON.parse(String(run?.init?.body))).toEqual({
      usernames: ["competitor"],
      dataToScrape: "followers",
      resultsLimit: 50,
    });
  });

  it("lets the followers actor and post count be configured", () => {
    const [p] = providersFromEnv({
      APIFY_TOKEN: "t",
      APIFY_FOLLOWERS_ACTOR: "someone~followers",
      APIFY_RECENT_POSTS: "30",
    });
    expect(p?.capabilities.has("account_followers")).toBe(true);
  });

  it("yields nothing when a competitor has no posts", async () => {
    const f = fakeFetch((url) =>
      url.includes("/limits") ? limits(5, 0) : json({ not: "an array" }),
    );
    const out: string[] = [];
    for await (const u of new ApifyProvider({ token: "t", fetch: f.fn }).listEngagers(
      { type: "profile", username: "c", url: "u" },
      5,
    ))
      out.push(u);
    expect(out).toEqual([]);
  });
});

describe("providersFromEnv", () => {
  it("orders the free worker before Apify and skips unconfigured ones", () => {
    expect(providersFromEnv({}).map((p) => p.id)).toEqual([]);
    expect(providersFromEnv({ WORKER_URL: "http://w", APIFY_TOKEN: "t" }).map((p) => p.id)).toEqual(
      ["worker", "apify"],
    );
    expect(
      providersFromEnv({ WORKER_URL: "http://w", WORKER_RATE_PER_MINUTE: "5" })[0]?.ratePerMinute,
    ).toBe(5);
  });
});
