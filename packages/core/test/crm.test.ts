import { competitorSnapshots, profiles as profilesTable } from "@scrapers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { parseSource, uploadSource } from "../src/source.js";
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
