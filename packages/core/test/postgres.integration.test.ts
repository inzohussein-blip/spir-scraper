/**
 * Runs the pipeline against a real Postgres with postgres.js and pg-boss, the
 * production drivers. PGlite (used everywhere else) is more forgiving about
 * parameter types, which once hid a bug, so CI runs this file on Postgres.
 *
 * Skipped unless TEST_DATABASE_URL is set. It truncates the app tables.
 */
import { fileURLToPath } from "node:url";
import * as schema from "@scrapers/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderRouter } from "../src/pipeline/router.js";
import { createScrapers } from "../src/pipeline/service.js";
import { parseSource, uploadSource } from "../src/source.js";
import { FakeProvider, fakeProfile } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../../db/drizzle", import.meta.url));

describe.skipIf(!url)("on real Postgres", () => {
  let client: ReturnType<typeof postgres>;
  let boss: PgBoss;
  let scrapers: ReturnType<typeof createScrapers>;

  beforeAll(async () => {
    client = postgres(url as string, { prepare: false, max: 5, onnotice: () => {} });
    const db = drizzle(client, { schema });
    await migrate(drizzle(postgres(url as string, { max: 1, onnotice: () => {} }), { schema }), {
      migrationsFolder,
    });
    await client`truncate projects, profiles, suppression, api_keys, audit_log, notifications, ephemeral, counters, push_subscriptions cascade`;
    boss = new PgBoss({ connectionString: url as string, supervise: false, schedule: false });
    boss.on("error", () => {});
    await boss.start();
    const apify = new FakeProvider("apify", ["account_engagers"], {
      engagers: () => ["user1", "user2", "user3", "user4"],
    });
    const worker = new FakeProvider("worker", ["profile"], { profile: fakeProfile });
    scrapers = createScrapers({
      db,
      boss,
      router: new ProviderRouter([apify, worker], { sleep: async () => {} }),
      resolve: {},
      config: { suppressionPepper: "pg" },
    });
    await scrapers.init();
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 1000 }).catch(() => {});
    await client?.end();
  });

  const settle = async () => {
    for (let i = 0; i < 50; i++)
      if ((await scrapers.drain({ budgetMs: 5_000 })).activeJobs === 0) return;
  };

  it("runs jobs, pages, searches and reports with the production drivers", async () => {
    const p = await scrapers.createProject({ name: "pg", owner: "o", watchKeywords: ["coach"] });
    const { job } = await scrapers.startJob({
      projectId: p.id,
      source: uploadSource(["user1", "user2", "user4", "user8"]),
      limit: 10,
    });
    await settle();
    expect((await scrapers.getJob(job.id)).counts).toMatchObject({ discovered: 4, enriched: 4 });

    const first = await scrapers.listLeadsPage({ projectId: p.id, limit: 3 });
    const second = await scrapers.listLeadsPage({
      projectId: p.id,
      limit: 3,
      cursor: first.nextCursor as string,
    });
    expect([...first.leads, ...second.leads].map((l) => l.username).sort()).toEqual([
      "user1",
      "user2",
      "user4",
      "user8",
    ]);
    expect(
      (await scrapers.listLeads({ projectId: p.id, q: "coach" })).map((l) => l.username).sort(),
    ).toEqual(["user4", "user8"]);

    const stats = await scrapers.overviewStats();
    expect(stats).toMatchObject({ leads: 4, jobsToday: 1, failedJobs7d: 0 });
    const health = await scrapers.systemHealth();
    expect(health.dbBytes).toBeGreaterThan(0);
    expect((await scrapers.listNotifications()).map((n) => n.title)).toEqual(
      expect.arrayContaining(["انتهت مهمة pg", "كلمات المراقبة: 2 حساب في pg"]),
    );
  });

  it("suppresses by phone hash and keeps CRM status", async () => {
    const [p] = await scrapers.listProjects();
    const projectId = p?.id as string;
    expect(
      await scrapers.setLeadStatus({ projectId, username: "user2", status: "contacted" }),
    ).toBe(true);
    expect(await scrapers.leadStatusCounts(projectId)).toMatchObject({ contacted: 1 });
    // Raw SQL report through postgres.js (rows come back as an array here).
    expect(await scrapers.setDeal({ projectId, username: "user2", value: 250 })).toBe(true);
    const perf = await scrapers.sourcePerformance(projectId);
    expect(perf.totals).toMatchObject({ revenue: 250, customers: 1 });
    expect(perf.sources[0]).toMatchObject({ customers: 1, revenue: 250 });
    await scrapers.suppress("phone", "+966501000004");
    expect((await scrapers.listLeads({ projectId })).map((l) => l.username)).not.toContain("user4");
  });

  it("handles monitors, counters, one-time claims and the weekly summary", async () => {
    const [p] = await scrapers.listProjects();
    const source = parseSource("@competitor");
    if (source.type !== "profile") throw new Error("unexpected");
    await scrapers.createMonitor({ projectId: p?.id as string, source, everyDays: 1 });
    const [jobId] = await scrapers.runDueMonitors();
    expect(await scrapers.runDueMonitors()).toEqual([]);
    expect((await scrapers.runDueMonitors(new Date(Date.now() + 2 * 86_400_000))).length).toBe(1);
    await settle();
    // user1 and user2 are already in the project; user3 is new; user4 was suppressed.
    expect((await scrapers.getJob(jobId as string)).counts.discovered).toBe(2);

    expect(await scrapers.hitCounter("pg", 60_000)).toBe(1);
    expect(await scrapers.hitCounter("pg", 60_000)).toBe(2);
    expect(await scrapers.claimOnce("pg-claim", 60_000)).toBe(true);
    expect(await scrapers.claimOnce("pg-claim", 60_000)).toBe(false);
    await scrapers.setValue("pg-value", { ok: true }, 60_000);
    expect(await scrapers.getValue("pg-value")).toEqual({ ok: true });
    expect(await scrapers.weeklySummary(new Date("2026-11-20T12:00:00Z"))).toContain("عملاء جدد");
    // Market index: array_agg ordering and regex topic counts on Postgres.
    const market = await scrapers.marketIndex();
    expect(market.months.at(-1)?.total).toBeGreaterThan(0);
    expect(market.topics.length).toBeGreaterThan(0);
    expect((await scrapers.contentPlan((p as { id: string }).id)).days).toHaveLength(7);
    await scrapers.storeMessage({ id: "pg-dm", threadId: "t1", direction: "in", text: "بكم؟" });
    expect((await scrapers.listThreads())[0]).toMatchObject({ threadId: "t1", unread: 1 });
    await scrapers.audit({ actor: "anon", action: "login.failed", ip: "9.9.9.9" });
    expect(await scrapers.failedLogins("9.9.9.9")).toMatchObject({ ip: 1 });
    await scrapers.handlers.retention();
  });
});
