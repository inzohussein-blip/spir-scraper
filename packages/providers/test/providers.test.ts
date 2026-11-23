import { BlockedError, BudgetExceededError, NotFoundError, RateLimitedError } from "@scrapers/core";
import { describe, expect, it } from "vitest";
import {
  ApifyProvider,
  mapApifyProfile,
  providersFromEnv,
  TikTokConnector,
  WorkerProvider,
} from "../src/index.js";

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

  it("reads many profiles in one run, 200 at a time", async () => {
    const f = fakeFetch((url, init) => {
      if (url.includes("/limits")) return limits(5, 0);
      const names = (JSON.parse(String(init?.body)) as { usernames: string[] }).usernames;
      return json([...names.filter((n) => n !== "u3").map((username) => ({ username })), {}]);
    });
    const p = new ApifyProvider({ token: "t", fetch: f.fn });
    const names = Array.from({ length: 250 }, (_, i) => `u${i}`);
    const out = await p.getProfiles(names);
    expect(out).toHaveLength(249);
    const runs = f.calls.filter((c) => c.url.includes("run-sync"));
    expect(runs).toHaveLength(2);
    expect(JSON.parse(String(runs[0]?.init?.body)).usernames).toHaveLength(200);
  });

  it("runs a large followers list in the background and reads every page", async () => {
    const page = (offset: number) =>
      Array.from({ length: offset === 0 ? 1000 : 300 }, (_, i) => ({ username: `f${offset + i}` }));
    const f = fakeFetch((url) => {
      if (url.includes("/limits")) return limits(5, 1);
      if (url.includes("/acts/") && url.includes("/runs?")) return json({ data: { id: "run9" } });
      if (url.includes("/actor-runs/run9"))
        return json({ data: { status: "SUCCEEDED", defaultDatasetId: "ds1" } });
      const offset = Number(new URL(url).searchParams.get("offset"));
      return json(page(offset));
    });
    const p = new ApifyProvider({ token: "t", fetch: f.fn });
    const source = {
      type: "followers",
      username: "big",
      url: "https://instagram.com/big/",
    } as const;
    await expect(
      p.startEngagers(source, 5000, "https://app.example/api/apify/webhook/x"),
    ).resolves.toEqual({
      runId: "run9",
    });
    const start = f.calls.find((c) => c.url.includes("/runs?"));
    const hooks = JSON.parse(
      Buffer.from(
        new URL(start?.url ?? "").searchParams.get("webhooks") ?? "",
        "base64",
      ).toString(),
    );
    expect(hooks[0].requestUrl).toBe("https://app.example/api/apify/webhook/x");
    expect(new URL(start?.url ?? "").searchParams.get("maxTotalChargeUsd")).toBe("4.00");
    const done = await p.collectEngagers("run9", source, 5000);
    expect(done.status).toBe("done");
    expect(done.status === "done" && done.usernames.length).toBe(1300);
    // Comments of a profile's posts need two runs: not started in the background.
    await expect(
      p.startEngagers(
        { type: "profile", username: "x", url: "https://instagram.com/x/" },
        5000,
        null,
      ),
    ).resolves.toBeNull();
  });

  it("collects keyword search, location posters and similar accounts", async () => {
    const f = fakeFetch((url, init) => {
      if (url.includes("/limits")) return limits(5, 0);
      const body = JSON.parse(String(init?.body));
      if (url.includes("instagram-search-scraper"))
        return json([{ username: "Coach1" }, { username: "coach2" }]);
      if (url.includes("apify~instagram-scraper"))
        return json([{ ownerUsername: "riyadh_trader" }, { ownerUsername: "fx_ksa" }]);
      if (body.usernames?.[0] === "gold")
        return json([
          { username: "gold", relatedProfiles: [{ username: "gold2" }, { username: "fx3" }] },
        ]);
      return json([]);
    });
    const p = new ApifyProvider({ token: "t", fetch: f.fn });
    const all = async (it: AsyncIterable<string>) => {
      const out: string[] = [];
      for await (const u of it) out.push(u);
      return out;
    };
    expect(
      await all(
        p.listEngagers({ type: "search", query: "مدرب", url: "https://www.instagram.com/" }, 50),
      ),
    ).toEqual(["coach1", "coach2"]);
    const searchRun = f.calls.find((c) => c.url.includes("search-scraper"));
    expect(JSON.parse(String(searchRun?.init?.body))).toMatchObject({
      search: "مدرب",
      searchType: "user",
    });
    expect(
      await all(
        p.listEngagers(
          {
            type: "location",
            locationId: "1",
            url: "https://www.instagram.com/explore/locations/1/",
          },
          50,
        ),
      ),
    ).toEqual(["riyadh_trader", "fx_ksa"]);
    expect(
      await all(
        p.listEngagers(
          { type: "similar", username: "gold", url: "https://www.instagram.com/gold/" },
          50,
        ),
      ),
    ).toEqual(["gold2", "fx3"]);
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

describe("Google Maps through Apify", () => {
  it("maps the places actor's items", async () => {
    const f = fakeFetch((url) =>
      url.includes("/limits")
        ? json({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 0 } } })
        : json([
            {
              placeId: "ChIJ1",
              title: "صرافة",
              categoryName: "Currency exchange",
              city: "Riyadh",
              countryCode: "sa",
              phone: "+966 50",
              website: "https://x.example",
              totalScore: 4.4,
              reviewsCount: 31,
              url: "https://maps.google.com/?cid=1",
            },
            { title: "no id" },
          ]),
    );
    const p = new ApifyProvider({ token: "t", fetch: f.fn });
    const places = await p.searchPlaces("صرافة", "الرياض", 5);
    expect(places).toEqual([
      {
        placeId: "ChIJ1",
        name: "صرافة",
        category: "Currency exchange",
        address: null,
        city: "Riyadh",
        country: "SA",
        phone: "+966 50",
        website: "https://x.example",
        rating: 4.4,
        reviews: 31,
        url: "https://maps.google.com/?cid=1",
      },
    ]);
    const run = f.calls.find((c) => c.url.includes("crawler-google-places"));
    expect(JSON.parse(String(run?.init?.body))).toMatchObject({
      searchStringsArray: ["صرافة"],
      locationQuery: "الرياض",
      maxCrawledPlacesPerSearch: 5,
    });
  });
});

describe("TikTok through Apify", () => {
  const limitsOk = () =>
    json({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 0 } } });
  it("reads the author of an account's latest video", async () => {
    const f = fakeFetch((url) =>
      url.includes("/limits")
        ? limitsOk()
        : json([
            {
              authorMeta: {
                name: "goldcoach",
                nickName: "Gold Coach",
                signature: "تداول الذهب",
                fans: 52000,
                heart: 900000,
                video: 140,
                following: 12,
                verified: false,
                bioLink: "https://t.me/goldcoach",
              },
            },
          ]),
    );
    const tt = new TikTokConnector(new ApifyProvider({ token: "t", fetch: f.fn }));
    expect(tt.paid).toBe(true);
    expect(await tt.getAccount("@goldcoach")).toEqual({
      displayName: "Gold Coach",
      bio: "تداول الذهب",
      followers: 52000,
      stats: { likes: 900000, videos: 140, following: 12, verified: false },
      links: ["https://t.me/goldcoach"],
    });
    const run = f.calls.find((c) => c.url.includes("tiktok-profile-scraper"));
    expect(JSON.parse(String(run?.init?.body))).toMatchObject({ profiles: ["goldcoach"] });
    const empty = new TikTokConnector(
      new ApifyProvider({
        token: "t",
        fetch: fakeFetch((url) => (url.includes("/limits") ? limitsOk() : json([]))).fn,
      }),
    );
    await expect(empty.getAccount("nobody")).rejects.toThrow(/not found/);
  });
});
