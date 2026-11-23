import { competitorSnapshots, profiles as profilesTable } from "@scrapers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { parseSource, uploadSource } from "../src/source.js";
import { AccountNotFoundError } from "../src/types.js";
import { FakeProvider, FakeScorer, fakeProfile, setup } from "./helpers.js";

type T = Awaited<ReturnType<typeof setup>>;
const settle = async (t: T) => {
  for (let i = 0; i < 50; i++)
    if ((await t.scrapers.drain({ budgetMs: 5_000 })).activeJobs === 0) return;
};

describe("sources, country and language", () => {
  it("keeps every competitor an account was found in, and filters by it", async () => {
    const lists: Record<string, string[]> = {
      first: ["user1", "user2", "user3"],
      second: ["user2", "user3", "user4"],
      third: ["user3"],
    };
    let current = "first";
    const t = await setup([
      new FakeProvider("apify", ["profile", "account_followers"], {
        profile: fakeProfile,
        engagers: () => lists[current] ?? [],
      }),
    ]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      for (const name of ["first", "second", "third"]) {
        current = name;
        await t.scrapers.startJob({
          projectId: p.id,
          source: parseSource(`https://instagram.com/${name}`, "followers"),
          limit: 10,
        });
        await settle(t);
      }
      const all = await t.scrapers.listLeads({ projectId: p.id });
      const by = (u: string) => all.find((l) => l.username === u);
      expect(by("user1")?.sourceCount).toBe(1);
      expect(by("user2")?.sourceCount).toBe(2);
      expect(by("user3")?.sourceCount).toBe(3);
      expect(by("user3")?.sources).toEqual([
        "https://www.instagram.com/first/followers/",
        "https://www.instagram.com/second/followers/",
        "https://www.instagram.com/third/followers/",
      ]);
      const repeat = await t.scrapers.listLeads({ projectId: p.id, minSources: 2 });
      expect(repeat.map((l) => l.username).sort()).toEqual(["user2", "user3"]);

      // Country from the 🇸🇦 bio, language from the letters used.
      expect(by("user4")?.country).toBe("SA");
      expect(by("user4")?.language).toBe("en");
      expect((await t.scrapers.listLeads({ projectId: p.id, country: "sa" })).length).toBe(1);
      expect((await t.scrapers.listLeads({ projectId: p.id, language: "en" })).length).toBe(4);
      expect((await t.scrapers.listLeads({ projectId: p.id, minFollowers: 103 })).length).toBe(2);
    } finally {
      await t.close();
    }
  });
});

describe("notes, history and bulk changes", () => {
  it("records status changes, follow-ups and notes, and changes many leads at once", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(["a1", "a2", "a3"]),
        limit: 10,
      });
      await settle(t);
      await t.scrapers.setLeadStatus({ projectId: p.id, username: "a1", status: "contacted" });
      expect(
        await t.scrapers.addLeadNote({ projectId: p.id, username: "@a1", text: "طلب العرض" }),
      ).toBe(true);
      expect(await t.scrapers.addLeadNote({ projectId: p.id, username: "a1", text: "  " })).toBe(
        false,
      );
      const detail = await t.scrapers.leadDetail(p.id, "a1");
      expect(detail?.lead.status).toBe("contacted");
      expect(detail?.events.map((e) => e.kind)).toEqual(["note", "status"]);
      expect(detail?.events[0]?.text).toBe("طلب العرض");
      expect(await t.scrapers.leadDetail(p.id, "ghost")).toBeNull();

      const day = new Date("2030-01-02T00:00:00Z");
      expect(
        await t.scrapers.bulkUpdateLeads({
          projectId: p.id,
          usernames: ["a2", "@A3", "ghost"],
          status: "interested",
          followUpAt: day,
        }),
      ).toBe(2);
      const interested = await t.scrapers.listLeads({ projectId: p.id, status: "interested" });
      expect(interested.map((l) => l.username).sort()).toEqual(["a2", "a3"]);
      expect(interested[0]?.followUpAt).toEqual(day);
      expect((await t.scrapers.leadDetail(p.id, "a2"))?.events[0]?.text).toContain("جماعي");
      expect(await t.scrapers.upcomingFollowUps()).toHaveLength(2);
    } finally {
      await t.close();
    }
  });
});

describe("profile changes and fake accounts", () => {
  it("tells the owner when a saved lead adds an email, and can skip fake-looking accounts", async () => {
    let withEmail = false;
    const t = await setup([
      new FakeProvider("worker", ["profile"], {
        profile: (u) =>
          u === "farm1"
            ? {
                igUserId: "id-farm1",
                username: "farm1",
                isBusiness: false,
                isVerified: false,
                followers: 10,
                following: 5000,
                posts: 0,
                bio: "follow back",
              }
            : {
                ...fakeProfile("b2"),
                businessEmail: withEmail ? "sales@example.com" : null,
                isBusiness: withEmail,
              },
      }),
    ]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await t.scrapers.updateProject(p.id, { skipFake: true });
      await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(["b2", "farm1"]),
        limit: 5,
      });
      await settle(t);
      expect((await t.scrapers.listLeads({ projectId: p.id })).map((l) => l.username)).toEqual([
        "b2",
      ]);

      // A month later the account adds an email: refetch (the cache is skipped by aging it).
      await t.db
        .update(profilesTable)
        .set({ fetchedAt: new Date(Date.now() - 400 * 86_400_000) })
        .where(eq(profilesTable.username, "b2"));
      await t.db.execute(
        "update leads set created_at = now() - interval '40 days'" as unknown as never,
      );
      withEmail = true;
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(["b2"]), limit: 1 });
      await settle(t);
      const bell = await t.scrapers.listNotifications(10);
      const alert = bell.find((n) => n.title.startsWith("تغيّرت حسابات"));
      expect(alert?.body).toContain("@b2: أضاف إيميلاً");
      expect((await t.scrapers.leadDetail(p.id, "b2"))?.events[0]).toMatchObject({
        kind: "change",
      });
    } finally {
      await t.close();
    }
  });
});

describe("competitors", () => {
  it("analyses a competitor and alerts on unusual growth", async () => {
    let followers = 10_000;
    const t = await setup(
      [
        new FakeProvider("apify", ["profile"], {
          profile: (u) => ({
            igUserId: `id-${u}`,
            username: u,
            isBusiness: true,
            isVerified: false,
            followers,
            posts: 50,
            bio: "Gold signals",
            recentPosts: [
              { likes: 500, comments: 20, type: "video", timestamp: "2026-11-20T15:00:00Z" },
              { likes: 100, comments: 5, type: "image", timestamp: "2026-11-19T15:00:00Z" },
            ],
          }),
        }),
      ],
      new FakeScorer(),
    );
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const a = await t.scrapers.analyzeCompetitor({ username: "@Rival", projectId: p.id });
      expect(a.followers).toBe(10_000);
      expect(a.analysis.byType[0]?.type).toBe("video");
      expect(a.growth).toBeNull();

      await t.scrapers.createMonitor({
        projectId: p.id,
        source: parseSource("https://instagram.com/rival", "followers") as never,
      });
      // Make yesterday's snapshot old enough, then the count jumps by 8%.
      await t.db
        .update(competitorSnapshots)
        .set({ at: new Date(Date.now() - 2 * 86_400_000) })
        .where(eq(competitorSnapshots.username, "rival"));
      followers = 10_800;
      const r = await t.scrapers.snapshotCompetitors();
      expect(r.alerts).toEqual(["@rival: +800 (8%)"]);
      expect((await t.scrapers.listNotifications(5))[0]?.title).toBe("نمو غير عادي عند منافس");
      // Once a day only.
      expect((await t.scrapers.snapshotCompetitors()).alerts).toEqual([]);
      expect(await t.scrapers.competitorHistory("rival")).toHaveLength(2);
      const again = await t.scrapers.analyzeCompetitor({ username: "rival" });
      expect(again.growth?.followers).toBe(0);
    } finally {
      await t.close();
    }
  });
});

describe("questions in plain language", () => {
  it("turns a question into filters with the scorer", async () => {
    const scorer = Object.assign(new FakeScorer(), {
      parseQuery: async () => ({ minFollowers: 102, business: true }),
    });
    const t = await setup(
      [new FakeProvider("worker", ["profile"], { profile: fakeProfile })],
      scorer,
    );
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(["c1", "c2", "c3", "c4"]),
        limit: 10,
      });
      await settle(t);
      const r = await t.scrapers.askLeads(p.id, "الحسابات التجارية فوق 102 متابع");
      expect(r.query).toEqual({ minFollowers: 102, business: true });
      expect(r.leads.map((l) => l.username).sort()).toEqual(["c2", "c4"]);
    } finally {
      await t.close();
    }
  });
});

describe("revenue by source", () => {
  it("records deals, costs jobs and credits revenue to the sources that found each customer", async () => {
    const lists: Record<string, string[]> = {
      alpha: ["u1", "u2", "u3"],
      beta: ["u3", "u4"],
    };
    let current = "alpha";
    const t = await setup([
      new FakeProvider(
        "apify",
        ["profile", "account_followers"],
        { profile: fakeProfile, engagers: () => lists[current] ?? [] },
        6000,
        2.5,
      ),
    ]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      for (const name of ["alpha", "beta"]) {
        current = name;
        await t.scrapers.startJob({
          projectId: p.id,
          source: parseSource(`https://instagram.com/${name}`, "followers"),
          limit: 10,
        });
        await settle(t);
      }
      // alpha: 3 discovered + 3 profiles read; beta: 2 discovered + 1 new profile (u3 cached).
      const jobs = await t.scrapers.listJobs({ projectId: p.id });
      const cost = (n: string) =>
        Number(jobs.find((j) => j.sourceUrl.includes(`/${n}/`))?.costUsd ?? 0);
      expect(cost("alpha")).toBeCloseTo(0.015, 4);
      expect(cost("beta")).toBeCloseTo(0.0075, 4);

      expect(await t.scrapers.setDeal({ projectId: p.id, username: "@u1", value: 300 })).toBe(true);
      expect(await t.scrapers.setDeal({ projectId: p.id, username: "u3", value: 1000 })).toBe(true);
      await t.scrapers.setLeadStatus({ projectId: p.id, username: "u4", status: "contacted" });
      expect(await t.scrapers.setDeal({ projectId: p.id, username: "ghost", value: 1 })).toBe(
        false,
      );

      const r = await t.scrapers.sourcePerformance(p.id);
      const by = (n: string) => r.sources.find((s) => s.source.includes(`/${n}/`));
      // u3 was found in both, so its 1000 is split 500/500.
      expect(by("alpha")).toMatchObject({ leads: 3, customers: 2, revenue: 800, reached: 2 });
      expect(by("beta")).toMatchObject({ leads: 2, customers: 1, revenue: 500, reached: 2 });
      expect(by("alpha")?.roi).toBeCloseTo(800 / 0.015, -1);
      expect(by("beta")?.closeRate).toBe(50);
      expect(r.totals).toMatchObject({ revenue: 1300, customers: 2, customersWithValue: 2 });
      expect(r.sources[0]?.source).toContain("/alpha/");

      const lead = (await t.scrapers.listLeads({ projectId: p.id })).find(
        (l) => l.username === "u1",
      );
      expect(lead).toMatchObject({ status: "customer", dealValue: 300 });
      expect((await t.scrapers.leadDetail(p.id, "u1"))?.events[0]?.text).toContain(
        "صفقة بقيمة 300",
      );
      await t.scrapers.setDeal({ projectId: p.id, username: "u1", value: null });
      expect((await t.scrapers.sourcePerformance(p.id)).totals.revenue).toBe(1000);
    } finally {
      await t.close();
    }
  });
});

describe("meaning, segments and timing", () => {
  const bios: Record<string, string> = {
    g1: "مدرب تداول الذهب XAUUSD توصيات يومية",
    g2: "توصيات الذهب gold signals daily",
    g3: "مدرب تداول ذهب وفوركس",
    n1: "طالب جامعي ابي اتعلم التداول مبتدئ",
    n2: "مبتدئ في عالم التداول وحاب اتعلم",
    r1: "مطعم مشويات في الرياض",
  };
  let followers = 4000;
  const provider = new FakeProvider("worker", ["profile"], {
    profile: (u) => ({
      igUserId: `id-${u}`,
      username: u,
      isBusiness: true,
      isVerified: false,
      followers: u === "g1" ? followers : 500,
      bio: bios[u] ?? "",
    }),
  });

  it("finds look-alikes, segments by meaning, and spots rising accounts", async () => {
    const scorer = Object.assign(new FakeScorer(), {
      personas: async () => [
        {
          name: "مدربو الذهب",
          description: "يدرّبون على الذهب",
          keywords: ["ذهب", "الذهب", "gold"],
        },
        { name: "مبتدئون", description: "يريدون التعلم", keywords: ["مبتدئ", "اتعلم"] },
        { name: "لا أحد", description: "", keywords: ["zzzz"] },
      ],
      parseQuery: async () => ({ terms: ["gold", "الذهب", "ذهب"] }),
    });
    const t = await setup([provider], scorer);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(Object.keys(bios)),
        limit: 10,
      });
      await settle(t);

      const like = await t.scrapers.similarLeads(p.id, "g1");
      expect(like[0]?.username).toMatch(/^g[23]$/);
      expect(like.map((l) => l.username)).not.toContain("r1");
      expect(like.map((l) => l.username)).not.toContain("g1");
      expect(await t.scrapers.similarLeads(p.id, "ghost")).toEqual([]);

      const built = await t.scrapers.buildPersonas(p.id);
      expect(built.assigned).toBe(5);
      const gold = await t.scrapers.listLeads({ projectId: p.id, persona: "مدربو الذهب" });
      expect(gold.map((l) => l.username).sort()).toEqual(["g1", "g2", "g3"]);
      await t.scrapers.setDeal({ projectId: p.id, username: "g2", value: 600 });
      const perf = await t.scrapers.personaPerformance(p.id);
      expect(perf[0]).toMatchObject({
        persona: "مدربو الذهب",
        leads: 3,
        customers: 1,
        revenue: 600,
      });

      // Questions by meaning use the synonyms the AI returns.
      const asked = await t.scrapers.askLeads(p.id, "مدربين الذهب");
      expect(asked.leads.map((l) => l.username).sort()).toEqual(["g1", "g2", "g3"]);

      // New accounts in a project with personas get one right away.
      bios.g4 = "gold coach";
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(["g4"]), limit: 1 });
      await settle(t);
      expect((await t.scrapers.listLeads({ projectId: p.id, q: "g4" }))[0]?.persona).toBe(
        "مدربو الذهب",
      );

      // g1 grows 30% over a month: rising, reported once.
      await t.db.execute("update profile_snapshots set at = now() - interval '30 days'" as never);
      await t.db.execute("update profiles set fetched_at = now() - interval '400 days'" as never);
      await t.db.execute("update leads set created_at = now() - interval '40 days'" as never);
      followers = 5200;
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(["g1"]), limit: 1 });
      await settle(t);
      const rising = await t.scrapers.listLeads({ projectId: p.id, signal: "rising" });
      expect(rising.map((l) => l.username)).toEqual(["g1"]);
      expect((await t.scrapers.leadDetail(p.id, "g1"))?.events[0]?.text).toContain(
        "ينمو بسرعة (+30%",
      );
    } finally {
      await t.close();
    }
  });

  it("needs an AI key for segments", async () => {
    const t = await setup([provider]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await expect(t.scrapers.buildPersonas(p.id)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      await t.close();
    }
  });
});

describe("people across platforms", () => {
  it("links accounts from bios, reads them through connectors and filters by platform", async () => {
    const bios: Record<string, string> = {
      a1: "مدرب ذهب | يوتيوب: @FxArab · تلكرام @gold_signals",
      a2: "no links here",
      a3: "https://www.tiktok.com/@a3coach",
    };
    const reads: string[] = [];
    const youtube = {
      platform: "youtube",
      getAccount: async (h: string) => {
        reads.push(`yt:${h}`);
        return { displayName: "FX Arab", bio: "قناة", followers: 15400, stats: { videos: 210 } };
      },
    };
    const telegram = {
      platform: "telegram",
      getAccount: async (h: string) => {
        reads.push(`tg:${h}`);
        if (h === "private_one") throw new AccountNotFoundError("chat not found");
        return { displayName: "إشارات", bio: null, followers: 8200 };
      },
    };
    const t = await setup(
      [
        new FakeProvider("worker", ["profile"], {
          profile: (u) => ({ ...fakeProfile(u), bio: bios[u] ?? "" }),
        }),
      ],
      undefined,
      { connectors: [youtube, telegram] },
    );
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(Object.keys(bios)),
        limit: 10,
      });
      await settle(t);

      // Found in the bios while collecting; nothing read yet.
      let a1 = await t.scrapers.personAccounts("a1");
      expect(a1.map((a) => `${a.platform}:${a.handle}:${a.source}`)).toEqual([
        "telegram:gold_signals:bio_link",
        "youtube:fxarab:bio_link",
      ]);
      expect(a1.every((a) => a.fetchedAt === null)).toBe(true);
      expect(await t.scrapers.platformCounts(p.id)).toEqual({ telegram: 1, tiktok: 1, youtube: 1 });

      // Reading them for leads collected before (or not yet read).
      const linked = await t.scrapers.linkProjectAccounts(p.id);
      expect(linked).toMatchObject({ leads: 3, found: 0, read: 0 });
      for (const a of a1) await t.scrapers.refreshAccount(a.id);
      a1 = await t.scrapers.personAccounts("a1");
      expect(a1.find((a) => a.platform === "youtube")).toMatchObject({
        displayName: "FX Arab",
        followers: 15400,
        stats: { videos: 210 },
        error: null,
      });
      expect(reads.sort()).toEqual(["tg:gold_signals", "yt:fxarab"]);

      // The owner pastes a link; a private chat is recorded as such.
      const added = await t.scrapers.addAccount({
        username: "a2",
        url: "https://t.me/private_one",
      });
      expect(added).toMatchObject({
        ok: true,
        account: { platform: "telegram", error: "غير موجود أو خاص" },
      });
      expect(
        await t.scrapers.addAccount({ username: "a2", url: "https://www.youtube.com/watch?v=1" }),
      ).toEqual({
        ok: false,
        reason: "not_account",
      });
      // An account already linked to someone else is not moved.
      const taken = await t.scrapers.addAccount({
        username: "a2",
        url: "https://t.me/gold_signals",
      });
      expect(taken).toMatchObject({ ok: false, reason: "taken" });

      expect(
        (await t.scrapers.listLeads({ projectId: p.id, platform: "youtube" })).map(
          (l) => l.username,
        ),
      ).toEqual(["a1"]);
      const detail = await t.scrapers.leadDetail(p.id, "a1");
      expect(detail?.accounts).toHaveLength(2);
      expect(t.scrapers.connectedPlatforms().sort()).toEqual(["telegram", "youtube"]);
    } finally {
      await t.close();
    }
  });
});

describe("daily account reads", () => {
  it("reads accounts that were never read, only for connected platforms", async () => {
    const t = await setup(
      [
        new FakeProvider("worker", ["profile"], {
          profile: (u) => ({ ...fakeProfile(u), bio: "يوتيوب: @chan1 تيك توك: @tt1" }),
        }),
      ],
      undefined,
      {
        connectors: [
          {
            platform: "youtube",
            getAccount: async () => ({ displayName: "C", bio: null, followers: 10 }),
          },
        ],
      },
    );
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(["b1"]), limit: 1 });
      await settle(t);
      expect(await t.scrapers.refreshPendingAccounts()).toBe(1);
      expect(await t.scrapers.refreshPendingAccounts()).toBe(0);
      const accs = await t.scrapers.personAccounts("b1");
      expect(accs.map((a) => [a.platform, a.followers])).toEqual([
        ["tiktok", null],
        ["youtube", 10],
      ]);
    } finally {
      await t.close();
    }
  });
});

describe("Google Maps businesses", () => {
  it("finds businesses, reads their sites for Instagram, and sends them as leads", async () => {
    const searches: string[] = [];
    const places = {
      placesCostPer1k: 4,
      searchPlaces: async (q: string, loc: string, limit: number) => {
        searches.push(`${q}|${loc}|${limit}`);
        return [
          {
            placeId: "p1",
            name: "صرافة الأمان",
            category: "مكتب صرافة",
            city: "الرياض",
            country: "SA",
            website: "https://aman.example",
            rating: 4.6,
            reviews: 120,
          },
          {
            placeId: "p2",
            name: "مركز التداول",
            website: "https://www.instagram.com/trade_center/",
          },
          { placeId: "p3", name: "بلا موقع", phone: "+966500000000" },
        ];
      },
    };
    const website = {
      platform: "website",
      getAccount: async (host: string) => ({
        displayName: host,
        bio: null,
        followers: null,
        stats: { emails: ["info@aman.example"] },
        links: ["https://www.instagram.com/aman_fx/", "https://t.me/aman"],
      }),
    };
    const t = await setup(
      [new FakeProvider("worker", ["profile"], { profile: fakeProfile })],
      undefined,
      { connectors: [website], places },
    );
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      expect(t.scrapers.placesAvailable).toBe(true);
      const r = await t.scrapers.searchPlaces({
        projectId: p.id,
        query: "مكتب صرافة",
        location: "الرياض",
        limit: 10,
      });
      expect(r).toEqual({ found: 3, costUsd: 0.012 });
      expect(searches).toEqual(["مكتب صرافة|الرياض|10"]);
      // Found again: updated, not duplicated.
      await t.scrapers.searchPlaces({
        projectId: p.id,
        query: "مكتب صرافة",
        location: "الرياض",
        limit: 10,
      });
      expect(await t.scrapers.listPlaces(p.id)).toHaveLength(3);
      expect(await t.scrapers.placeQueries(p.id)).toEqual([
        { query: "مكتب صرافة · الرياض", count: 3 },
      ]);

      expect(await t.scrapers.analyzePlaces(p.id)).toEqual({ analyzed: 2, instagram: 2 });
      expect(await t.scrapers.analyzePlaces(p.id)).toEqual({ analyzed: 0, instagram: 0 });
      const list = await t.scrapers.listPlaces(p.id);
      const by = (id: string) => list.find((x) => x.placeId === id);
      expect(by("p1")).toMatchObject({
        instagram: "aman_fx",
        emails: ["info@aman.example"],
        rating: "4.6",
      });
      expect(by("p2")?.instagram).toBe("trade_center");

      const sent = await t.scrapers.placesToLeads(p.id);
      expect(sent.sent).toBe(2);
      await settle(t);
      const leads = await t.scrapers.listLeads({ projectId: p.id });
      expect(leads.map((l) => l.username).sort()).toEqual(["aman_fx", "trade_center"]);
      expect(leads[0]?.sources?.[0]).toBe("خرائط جوجل: مكتب صرافة · الرياض");
      expect((await t.scrapers.placesToLeads(p.id)).sent).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("needs Apify for searches", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      expect(t.scrapers.placesAvailable).toBe(false);
      await expect(
        t.scrapers.searchPlaces({ projectId: p.id, query: "x", location: "y" }),
      ).rejects.toThrow(/APIFY_TOKEN/);
    } finally {
      await t.close();
    }
  });
});

describe("paid connectors", () => {
  it("are never read by the daily task, only when asked", async () => {
    let reads = 0;
    const t = await setup(
      [
        new FakeProvider("worker", ["profile"], {
          profile: (u) => ({ ...fakeProfile(u), bio: "tiktok: @paid_one" }),
        }),
      ],
      undefined,
      {
        connectors: [
          {
            platform: "tiktok",
            paid: true,
            getAccount: async () => {
              reads++;
              return { displayName: "T", bio: null, followers: 5 };
            },
          },
        ],
      },
    );
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(["c1"]), limit: 1 });
      await settle(t);
      expect(await t.scrapers.refreshPendingAccounts()).toBe(0);
      expect(reads).toBe(0);
      const [acc] = await t.scrapers.personAccounts("c1");
      await t.scrapers.refreshAccount(acc?.id as string);
      expect(reads).toBe(1);
    } finally {
      await t.close();
    }
  });
});

describe("competitor websites", () => {
  it("sets a baseline, then reports added and removed lines once a day", async () => {
    let text = "Acme FX\nعمولة الوكيل 5$ لكل لوت\nسجّل الآن";
    const t = await setup(
      [new FakeProvider("worker", ["profile"], { profile: fakeProfile })],
      undefined,
      {
        readPage: async () => ({ title: "Acme partners", text }),
      },
    );
    try {
      const w = await t.scrapers.addSiteWatch({
        url: "acme.example/partners",
        label: "عمولات Acme",
      });
      expect(w?.url).toBe("https://acme.example/partners");
      const t0 = new Date("2030-01-01T00:00:00Z");
      expect(await t.scrapers.checkSiteWatches(t0)).toEqual({ checked: 1, changed: 0 });
      // Too soon to check again.
      expect(await t.scrapers.checkSiteWatches(new Date(t0.getTime() + 3_600_000))).toEqual({
        checked: 0,
        changed: 0,
      });

      text = "Acme FX\nعمولة الوكيل 8$ لكل لوت\nسجّل الآن\nمسابقة الشهر للوكلاء";
      const t1 = new Date(t0.getTime() + 24 * 3_600_000);
      expect(await t.scrapers.checkSiteWatches(t1)).toEqual({ checked: 1, changed: 1 });
      const [watch] = await t.scrapers.listSiteWatches();
      expect(watch?.lastDiff).toEqual({
        added: ["عمولة الوكيل 8$ لكل لوت", "مسابقة الشهر للوكلاء"],
        removed: ["عمولة الوكيل 5$ لكل لوت"],
      });
      const bell = await t.scrapers.listNotifications(3);
      expect(bell[0]?.title).toBe("تغيّر 1 من مواقع المنافسين");
      expect(bell[0]?.body).toContain("+ عمولة الوكيل 8$ لكل لوت");

      // Unchanged the next day: no alert.
      expect(await t.scrapers.checkSiteWatches(new Date(t1.getTime() + 24 * 3_600_000))).toEqual({
        checked: 1,
        changed: 0,
      });
      await t.scrapers.removeSiteWatch(watch?.id as string);
      expect(await t.scrapers.listSiteWatches()).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

describe("the project's own model", () => {
  it("waits for enough decisions, then learns them and scores every lead", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const names = Array.from({ length: 40 }, (_, i) => `m${i + 1}`);
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(names), limit: 40 });
      await settle(t);
      const all = await t.scrapers.listLeads({ projectId: p.id, limit: 100 });
      const withPhone = all.filter((l) => l.phone).map((l) => l.username);
      const without = all.filter((l) => !l.phone).map((l) => l.username);

      // Two decisions are not enough to learn from.
      await t.scrapers.setLeadStatus({
        projectId: p.id,
        username: withPhone[0] as string,
        status: "customer",
      });
      await t.scrapers.setLeadStatus({
        projectId: p.id,
        username: without[0] as string,
        status: "rejected",
      });
      const early = await t.scrapers.trainProjectModel(p.id);
      expect(early).toMatchObject({ trained: false, positives: 1, negatives: 1 });

      // The owner's customers all have a phone; the rejected ones do not.
      await t.scrapers.bulkUpdateLeads({
        projectId: p.id,
        usernames: withPhone.slice(0, 9),
        status: "customer",
      });
      await t.scrapers.bulkUpdateLeads({
        projectId: p.id,
        usernames: without.slice(0, 15),
        status: "rejected",
      });
      const r = await t.scrapers.trainProjectModel(p.id);
      expect(r).toMatchObject({ trained: true, scored: 40 });
      if (!r.trained) return;
      expect(r.auc).toBeGreaterThan(0.8);

      const leads = await t.scrapers.listLeads({ projectId: p.id, limit: 100 });
      const unseenPhone = leads.find((l) => l.phone && l.status === "new");
      const unseenNone = leads.find((l) => !l.phone && l.status === "new");
      expect(unseenPhone?.winProb ?? 0).toBeGreaterThan(unseenNone?.winProb ?? 100);
      expect(
        (await t.scrapers.listLeads({ projectId: p.id, minWinProb: 50 })).every((l) => l.phone),
      ).toBe(true);

      const ev = await t.scrapers.evaluateScoring(p.id);
      expect(ev.labelled).toBe(24);
      expect(ev.model?.explain[0]?.label).toBe("له رقم");
      expect(ev.aiScoreAuc).toBeNull();

      // New leads get a probability as they arrive.
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(["m100"]), limit: 1 });
      await settle(t);
      expect(
        (await t.scrapers.listLeads({ projectId: p.id, q: "m100" }))[0]?.winProb,
      ).not.toBeNull();
    } finally {
      await t.close();
    }
  });
});

describe("budget and the network", () => {
  it("plans the budget by revenue, applies it to monitors, and finds sources from customers' follows", async () => {
    const lists: Record<string, string[]> = {
      winner: Array.from({ length: 30 }, (_, i) => `w${i}`),
      loser: Array.from({ length: 30 }, (_, i) => `l${i}`),
    };
    let current = "winner";
    const followed: Record<string, string[]> = {
      w0: ["hub_gold", "hub_fx", "random1"],
      w1: ["hub_gold", "hub_fx"],
      w2: ["hub_gold", "winner"],
    };
    const t = await setup(
      [
        new FakeProvider(
          "apify",
          ["profile", "account_followers"],
          { profile: fakeProfile, engagers: () => lists[current] ?? [] },
          6000,
          2.5,
        ),
      ],
      undefined,
      {
        following: {
          followingCostPer1k: 2.5,
          listFollowing: async (u: string) => followed[u] ?? [],
        },
      },
    );
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      for (const name of ["winner", "loser"]) {
        current = name;
        const source = parseSource(`https://instagram.com/${name}`, "followers") as never;
        await t.scrapers.createMonitor({ projectId: p.id, source, everyDays: 7, limit: 100 });
        await t.scrapers.startJob({ projectId: p.id, source, limit: 30 });
        await settle(t);
      }
      // 25 reached from each; 3 customers from the winner only.
      await t.scrapers.bulkUpdateLeads({
        projectId: p.id,
        usernames: lists.winner?.slice(3, 25) ?? [],
        status: "contacted",
      });
      await t.scrapers.bulkUpdateLeads({
        projectId: p.id,
        usernames: lists.loser?.slice(0, 25) ?? [],
        status: "rejected",
      });
      for (const u of ["w0", "w1", "w2"])
        await t.scrapers.setDeal({ projectId: p.id, username: u, value: 300 });

      const plan = await t.scrapers.budgetPlan(p.id, 10);
      const by = (n: string) => plan.lines.find((l) => l.source.includes(`/${n}/`));
      expect(by("winner")).toMatchObject({ decision: "increase", usd: 10, accounts: 2000 });
      expect(by("loser")).toMatchObject({ decision: "stop", usd: 0 });
      expect(by("winner")?.monitorId).not.toBeNull();

      expect(await t.scrapers.applyBudgetPlan(p.id, plan.lines)).toEqual({ changed: 2 });
      const mons = await t.scrapers.listMonitors(p.id);
      const mon = (n: string) => mons.find((m) => m.sourceUrl.includes(`/${n}/`));
      expect(mon("loser")?.enabled).toBe(false);
      // 2000 accounts a month over about 4 runs.
      expect(mon("winner")).toMatchObject({ enabled: true, limit: 500 });

      expect(t.scrapers.suggestCost(8, 150)).toBe(3);
      const s = await t.scrapers.suggestSources(p.id);
      expect(s.seeds).toBe(3);
      // Followed by 2+ customers, not already watched, not a customer itself.
      expect(s.suggestions).toEqual([
        { username: "hub_gold", followedBy: 3 },
        { username: "hub_fx", followedBy: 2 },
      ]);
      expect((await t.scrapers.lastSuggestions(p.id))?.suggestions).toHaveLength(2);
    } finally {
      await t.close();
    }
  });
});

describe("weekly analyst", () => {
  it("writes the plan, keeps budget changes pending, and applies them once on approval", async () => {
    const lists: Record<string, string[]> = {
      good: Array.from({ length: 25 }, (_, i) => `g${i}`),
      bad: Array.from({ length: 25 }, (_, i) => `b${i}`),
    };
    let current = "good";
    const t = await setup([
      new FakeProvider(
        "apify",
        ["profile", "account_followers"],
        { profile: fakeProfile, engagers: () => lists[current] ?? [] },
        6000,
        2.5,
      ),
    ]);
    try {
      const p = await t.scrapers.createProject({ name: "وكلاء", owner: "o" });
      for (const name of ["good", "bad"]) {
        current = name;
        const source = parseSource(`https://instagram.com/${name}`, "followers") as never;
        await t.scrapers.createMonitor({ projectId: p.id, source });
        await t.scrapers.startJob({ projectId: p.id, source, limit: 25 });
        await settle(t);
      }
      await t.scrapers.bulkUpdateLeads({
        projectId: p.id,
        usernames: lists.good?.slice(2, 22) ?? [],
        status: "contacted",
      });
      await t.scrapers.bulkUpdateLeads({
        projectId: p.id,
        usernames: lists.bad?.slice(0, 22) ?? [],
        status: "rejected",
      });
      for (const u of ["g0", "g1"])
        await t.scrapers.setDeal({ projectId: p.id, username: u, value: 400 });

      const plan = await t.scrapers.weeklyPlan(p.id, 8);
      expect(plan.changes).toBe(2);
      expect(plan.text).toContain("خطة الأسبوع · وكلاء");
      expect(plan.text).toContain("$800");
      expect(plan.text).toMatch(/أوقف https:\/\/www\.instagram\.com\/bad\/followers\//);
      // Nothing changes before approval.
      expect((await t.scrapers.listMonitors(p.id)).every((m) => m.enabled)).toBe(true);
      expect((await t.scrapers.lastPlan(p.id))?.id).toBe(plan.id);

      expect(await t.scrapers.approvePlan(plan.id)).toEqual({ ok: true, changed: 2 });
      const bad = (await t.scrapers.listMonitors(p.id)).find((m) => m.sourceUrl.includes("/bad/"));
      expect(bad?.enabled).toBe(false);
      expect(await t.scrapers.approvePlan(plan.id)).toEqual({ ok: false, reason: "applied" });
      expect(await t.scrapers.approvePlan("000000000000")).toEqual({
        ok: false,
        reason: "expired",
      });
    } finally {
      await t.close();
    }
  });
});

describe("broker reports and partners", () => {
  it("matches broker events to leads and partners, updates deals, and ranks recruits", async () => {
    const t = await setup([
      new FakeProvider("worker", ["profile"], {
        profile: (u) =>
          u === "coach1"
            ? { ...fakeProfile("coach1"), followers: 45_000, isBusiness: true }
            : fakeProfile(u),
      }),
    ]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(["b1", "b4", "coach1"]),
        limit: 5,
      });
      await settle(t);
      const leads = await t.scrapers.listLeads({ projectId: p.id });
      const withEmail = leads.find((l) => l.email);
      const withPhone = leads.find((l) => l.phoneConfirmed);
      expect(withEmail && withPhone).toBeTruthy();

      const partner = await t.scrapers.createPartner({
        name: "مدرب الذهب",
        code: "Gold7",
        sharePercent: 30,
      });
      expect(partner.code).toBe("gold7");
      await t.scrapers.recordClick(partner.id);
      await t.scrapers.recordClick(partner.id);

      const events = [
        {
          event: "registration" as const,
          externalId: "c1",
          email: withEmail?.email ?? null,
          phone: null,
          amount: null,
          currency: null,
          sub: "gold7",
          at: new Date("2030-01-01"),
        },
        {
          event: "ftd" as const,
          externalId: "c1",
          email: withEmail?.email ?? null,
          phone: null,
          amount: 1000,
          currency: "USD",
          sub: "gold7",
          at: new Date("2030-01-02"),
        },
        {
          event: "commission" as const,
          externalId: "c1",
          email: withEmail?.email ?? null,
          phone: null,
          amount: 150,
          currency: "USD",
          sub: "gold7",
          at: new Date("2030-01-10"),
        },
        {
          event: "ftd" as const,
          externalId: "c2",
          email: null,
          phone: withPhone?.phone ?? null,
          amount: 500,
          currency: "USD",
          sub: null,
          at: new Date("2030-01-03"),
        },
        {
          event: "ftd" as const,
          externalId: "c9",
          email: "stranger@x.com",
          phone: null,
          amount: 200,
          currency: "USD",
          sub: null,
          at: new Date("2030-01-04"),
        },
      ];
      expect(await t.scrapers.ingestBrokerEvents(events, "postback")).toEqual({
        stored: 5,
        matched: 4,
        duplicates: 0,
      });
      // The same report again changes nothing.
      expect(await t.scrapers.ingestBrokerEvents(events, "csv")).toEqual({
        stored: 0,
        matched: 0,
        duplicates: 5,
      });

      const after = await t.scrapers.listLeads({ projectId: p.id });
      // Commission wins over deposits as the deal value; deposits alone count when no commission came.
      expect(after.find((l) => l.username === withEmail?.username)).toMatchObject({
        status: "customer",
        dealValue: 150,
      });
      expect(after.find((l) => l.username === withPhone?.username)).toMatchObject({
        status: "customer",
        dealValue: 500,
      });

      const sum = await t.scrapers.brokerSummary();
      expect(sum.byEvent.ftd).toEqual({ count: 3, matched: 2, amount: 1700 });
      const [stats] = await t.scrapers.partnerStats();
      expect(stats).toMatchObject({
        clicks: 2,
        registrations: 1,
        ftds: 1,
        deposits: 1000,
        commission: 150,
        partnerShare: 45,
      });
      expect((await t.scrapers.partnerByToken(partner.portalToken))?.id).toBe(partner.id);

      const recruits = await t.scrapers.recruitCandidates(p.id);
      expect(recruits.map((r) => r.username)).toEqual(["coach1"]);
    } finally {
      await t.close();
    }
  });
});
