import { leads as leadsTable, profiles as profilesTable } from "@scrapers/db";
import { describe, expect, it } from "vitest";
import { parseSource, uploadSource } from "../src/source.js";
import { RateLimitedError } from "../src/types.js";
import { FakeProvider, FakeScorer, fakeProfile, setup } from "./helpers.js";

const names = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `user${i + from}`);
const settle = async (t: Awaited<ReturnType<typeof setup>>) => {
  for (let i = 0; i < 50; i++)
    if ((await t.scrapers.drain({ budgetMs: 5_000 })).activeJobs === 0) return;
};

describe("profile cache", () => {
  it("reuses profiles fetched recently instead of asking providers again", async () => {
    const worker = new FakeProvider("worker", ["profile"], { profile: fakeProfile });
    const t = await setup([worker]);
    try {
      const a = await t.scrapers.createProject({ name: "a", owner: "o" });
      const b = await t.scrapers.createProject({ name: "b", owner: "o" });
      await t.scrapers.startJob({ projectId: a.id, source: uploadSource(names(4)), limit: 10 });
      await settle(t);
      expect(worker.calls).toBe(4);
      const { job } = await t.scrapers.startJob({
        projectId: b.id,
        source: uploadSource(names(4)),
        limit: 10,
      });
      await settle(t);
      expect(worker.calls).toBe(4);
      expect((await t.scrapers.getJob(job.id)).counts).toMatchObject({
        enriched: 4,
        cached: 4,
        leads: 2,
      });
      // Expired cache entries are fetched again.
      await t.db.update(profilesTable).set({ fetchedAt: new Date(Date.now() - 30 * 86_400_000) });
      await t.scrapers.startJob({ projectId: b.id, source: uploadSource(names(2)), limit: 10 });
      await settle(t);
      expect(worker.calls).toBe(6);
    } finally {
      await t.close();
    }
  });
});

describe("resume after rate limits", () => {
  it("defers the rest of a batch when every provider is resting", async () => {
    let limited = false;
    const worker = new FakeProvider("worker", ["profile"], {
      profile: (u) => {
        if (limited) throw new RateLimitedError("429", "worker");
        return fakeProfile(u);
      },
    });
    const t = await setup([worker]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const { job } = await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(names(3)),
        limit: 10,
      });
      await t.scrapers.handlers.discover({ jobId: job.id, usernames: names(3) });
      limited = true;
      await t.scrapers.handlers.enrich({ jobId: job.id, usernames: names(3) });
      const j = await t.scrapers.getJob(job.id);
      expect(j.status).toBe("running");
      expect(j.counts.failed ?? 0).toBe(0);
      const { rows } = await t.pg.query<{ data: { usernames: string[] }; start_after: string }>(
        "select data, start_after from pgboss.job where name = 'scrapers-enrich' and state = 'created' order by start_after desc",
      );
      expect(rows[0]?.data.usernames).toEqual(names(3));
      expect(new Date(rows[0]?.start_after as string).getTime()).toBeGreaterThan(
        Date.now() + 60_000,
      );
      expect((await t.scrapers.listNotifications()).map((n) => n.title)).toContain(
        "أُجّل 3 حساباً في مهمة p",
      );
      // State survives into a fresh router (serverless instance).
      expect(
        Object.keys((await t.scrapers.getValue<Record<string, unknown>>("router:state")) ?? {}),
      ).toEqual(["worker"]);
    } finally {
      await t.close();
    }
  });
});

describe("lead workflow", () => {
  it("keeps status across refreshes, filters by it and counts it", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(names(4)), limit: 10 });
      await settle(t);
      expect(
        await t.scrapers.setLeadStatus({
          projectId: p.id,
          username: "@User2",
          status: "contacted",
          note: "راسلته",
        }),
      ).toBe(true);
      expect(
        await t.scrapers.setLeadStatus({ projectId: p.id, username: "ghost", status: "contacted" }),
      ).toBe(false);
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(["user2"]), limit: 1 });
      await settle(t);
      const contacted = await t.scrapers.listLeads({ projectId: p.id, status: "contacted" });
      expect(contacted).toEqual([
        expect.objectContaining({ username: "user2", status: "contacted", statusNote: "راسلته" }),
      ]);
      expect(await t.scrapers.leadStatusCounts(p.id)).toEqual({ new: 3, contacted: 1 });
    } finally {
      await t.close();
    }
  });

  it("pages with a cursor, searches text and counts other projects", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const q = await t.scrapers.createProject({ name: "q", owner: "o" });
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(names(7)), limit: 10 });
      await t.scrapers.startJob({ projectId: q.id, source: uploadSource(["user3"]), limit: 1 });
      await settle(t);
      await t.db.update(leadsTable).set({ aiScore: 50 });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const page = await t.scrapers.listLeadsPage({
          projectId: p.id,
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.leads.map((l) => l.username));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect(
        (await t.scrapers.listLeads({ projectId: p.id, q: "USER3" })).map((l) => [
          l.username,
          l.otherProjects,
        ]),
      ).toEqual([["user3", 1]]);
      expect(
        (await t.scrapers.listLeads({ projectId: p.id, q: "trading coach" })).map(
          (l) => l.username,
        ),
      ).toEqual(["user4"]);
      expect(await t.scrapers.listLeads({ projectId: p.id, q: "100%_" })).toHaveLength(0);
      expect(await t.scrapers.listLeadsPage({ projectId: p.id, cursor: "garbage" })).toMatchObject({
        leads: expect.any(Array),
      });
    } finally {
      await t.close();
    }
  });

  it("alerts on watch keywords", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o", watchKeywords: ["coach"] });
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(names(4)), limit: 10 });
      await settle(t);
      const n = (await t.scrapers.listNotifications()).find((x) =>
        x.title.startsWith("كلمات المراقبة"),
      );
      expect(n?.title).toBe("كلمات المراقبة: 1 حساب في p");
      expect(n?.body).toBe("@user4");
    } finally {
      await t.close();
    }
  });
});

describe("auto score and export", () => {
  it("scores finished jobs with the project criteria, then hands them to the exporter", async () => {
    const ready: string[] = [];
    const t = await setup(
      [new FakeProvider("worker", ["profile"], { profile: fakeProfile })],
      new FakeScorer(100),
    );
    try {
      const { createScrapers } = await import("../src/pipeline/service.js");
      const s = createScrapers({
        db: t.db,
        boss: t.boss,
        router: t.router,
        scorer: new FakeScorer(100),
        resolve: {},
        config: { suppressionPepper: "p" },
        onReadyToExport: async (id) => void ready.push(id),
      });
      const p = await s.createProject({
        name: "p",
        owner: "o",
        aiCriteria: "agents",
        autoExport: true,
      });
      const { job } = await s.startJob({
        projectId: p.id,
        source: uploadSource(names(3)),
        limit: 5,
      });
      for (let i = 0; i < 20 && (await s.drain({ budgetMs: 5000 })).activeJobs > 0; i++);
      expect(ready).toEqual([job.id]);
      expect((await s.getJob(job.id)).counts.scored).toBe(3);
      expect((await s.listLeads({ projectId: p.id })).every((l) => l.aiScore !== null)).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe("monitors", () => {
  it("runs due monitors and collects only new accounts", async () => {
    let engagers = names(3);
    const apify = new FakeProvider("apify", ["account_engagers"], { engagers: () => engagers });
    const t = await setup([
      apify,
      new FakeProvider("worker", ["profile"], { profile: fakeProfile }),
    ]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const source = parseSource("https://instagram.com/competitor");
      if (source.type !== "profile") throw new Error("unexpected");
      const m = await t.scrapers.createMonitor({ projectId: p.id, source, everyDays: 7 });
      const [first] = await t.scrapers.runDueMonitors();
      expect(await t.scrapers.runDueMonitors()).toEqual([]);
      await settle(t);
      expect((await t.scrapers.getJob(first as string)).counts.discovered).toBe(3);
      engagers = names(5);
      const later = new Date(Date.now() + 8 * 86_400_000);
      const [second] = await t.scrapers.runDueMonitors(later);
      await settle(t);
      expect((await t.scrapers.getJob(second as string)).counts.discovered).toBe(2);
      await t.scrapers.setMonitorEnabled(m.id, false);
      expect(await t.scrapers.runDueMonitors(new Date(Date.now() + 30 * 86_400_000))).toEqual([]);
      expect(await t.scrapers.listMonitors(p.id)).toHaveLength(1);
      await t.scrapers.deleteMonitor(m.id);
      expect(await t.scrapers.listMonitors()).toHaveLength(0);
    } finally {
      await t.close();
    }
  });
});

describe("shared stores, weekly summary and health", () => {
  it("counts in windows, claims once and stores values", async () => {
    const t = await setup([]);
    try {
      expect(await t.scrapers.hitCounter("k", 60_000)).toBe(1);
      expect(await t.scrapers.hitCounter("k", 60_000)).toBe(2);
      await t.pg.query("update counters set expires_at = now() - interval '1 second'");
      expect(await t.scrapers.hitCounter("k", 60_000)).toBe(1);
      expect(await t.scrapers.claimOnce("code:1", 60_000)).toBe(true);
      expect(await t.scrapers.claimOnce("code:1", 60_000)).toBe(false);
      await t.scrapers.setValue("v", { a: 1 }, 60_000);
      expect(await t.scrapers.getValue("v")).toEqual({ a: 1 });
      await t.scrapers.setValue("old", 1, -1);
      expect(await t.scrapers.getValue("old")).toBeNull();
      await t.scrapers.handlers.retention();
      expect((await t.pg.query("select count(*)::int as n from ephemeral")).rows).toEqual([
        { n: 2 },
      ]);
    } finally {
      await t.close();
    }
  });

  it("sends the weekly summary once on the configured day", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(names(2)), limit: 5 });
      await settle(t);
      const friday = new Date("2026-11-20T12:00:00Z");
      const thursday = new Date("2026-11-19T12:00:00Z");
      expect(await t.scrapers.weeklySummary(thursday)).toBeNull();
      expect(await t.scrapers.weeklySummary(friday)).toContain("مهام اكتملت: 1");
      expect(await t.scrapers.weeklySummary(friday)).toBeNull();
      const health = await t.scrapers.systemHealth();
      expect(health).toMatchObject({ leads: 2, profiles: 2, jobs: 1, lastCron: null });
      expect(health.dbBytes).toBeGreaterThan(0);
    } finally {
      await t.close();
    }
  });
});
