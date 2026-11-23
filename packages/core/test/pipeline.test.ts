import { leads as leadsTable } from "@scrapers/db";
import { describe, expect, it } from "vitest";
import { ENRICH_BATCH } from "../src/pipeline/service.js";
import { parseSource, uploadSource } from "../src/source.js";
import { NotFoundError, RateLimitedError } from "../src/types.js";
import { FakeProvider, fakeProfile, setup } from "./helpers.js";

const usernames = (n: number) => Array.from({ length: n }, (_, i) => `user${i + 1}`);

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("pipeline through pg-boss workers", () => {
  it("runs an upload job end to end", async () => {
    const worker = new FakeProvider("worker", ["profile"], { profile: fakeProfile });
    const t = await setup([worker]);
    try {
      await t.scrapers.work({ pollingIntervalSeconds: 0.5 });
      const project = await t.scrapers.createProject({ name: "p", owner: "o@example.com" });
      const { job, estimatedCostUsd } = await t.scrapers.startJob({
        projectId: project.id,
        source: uploadSource(usernames(120)),
        limit: 500,
      });
      expect(estimatedCostUsd).toBe(0);
      const done = await waitFor(
        () => t.scrapers.getJob(job.id),
        (j) => j.status === "done",
      );
      expect(done.counts).toMatchObject({ discovered: 120, enriched: 120 });
      expect(done.progress).toBe(1);
      // kinds 0 and 1 are businesses with a contact; 2 has none; 3 is personal.
      expect(done.counts.leads).toBe(60);

      const rows = await t.scrapers.listLeads({ projectId: project.id, limit: 1000 });
      expect(rows).toHaveLength(120);
      const personal = rows.filter((r) => !r.isBusiness);
      expect(personal.every((r) => r.email === null && r.phone === null)).toBe(true);
      const saudi = rows.find((r) => r.username === "user4");
      expect(saudi).toMatchObject({
        phone: "+966501000004",
        phoneCountry: "SA",
        phoneConfirmed: true,
        contactSource: "bio",
      });
      expect(rows.find((r) => r.username === "user1")?.email).toBe("user1@example-fx.com");
    } finally {
      await t.close();
    }
  });
});

describe("pipeline handlers", () => {
  async function runJob(t: Awaited<ReturnType<typeof setup>>, projectId: string, names: string[]) {
    const { job } = await t.scrapers.startJob({
      projectId,
      source: uploadSource(names),
      limit: 1000,
    });
    await t.scrapers.handlers.discover({ jobId: job.id, usernames: names });
    for (let i = 0; i < names.length; i += ENRICH_BATCH) {
      await t.scrapers.handlers.enrich({
        jobId: job.id,
        usernames: names.slice(i, i + ENRICH_BATCH),
      });
    }
    return t.scrapers.getJob(job.id);
  }

  it("reads uncached accounts in one batch call and skips those it did not return", async () => {
    const batches: string[][] = [];
    const apify = new FakeProvider("apify", ["profile"], { profile: fakeProfile }, 6000, 2.5);
    Object.assign(apify, {
      getProfiles: async (names: string[]) => {
        batches.push(names);
        return names.filter((u) => u !== "private1").map(fakeProfile);
      },
    });
    const t = await setup([apify]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const names = Array.from({ length: 20 }, (_, i) => `user${i + 1}`).concat("private1");
      const job = await runJob(t, p.id, names);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(21);
      expect(apify.calls).toBe(0); // no account was read on its own
      expect(job.counts).toMatchObject({ discovered: 21, enriched: 20, skipped: 1 });
      // Cached accounts are not read again.
      await runJob(t, p.id, ["user1", "user2", "user99"]);
      expect(batches).toHaveLength(1);
      expect(apify.calls).toBe(1); // user99 alone: one account is read directly
    } finally {
      await t.close();
    }
  });

  it("collects a large list in a background run and continues when it ends", async () => {
    let state: "running" | "done" = "running";
    const started: { limit: number; url: string | null }[] = [];
    const apify = new FakeProvider("apify", ["profile", "account_followers"], {
      profile: fakeProfile,
    });
    Object.assign(apify, {
      startEngagers: async (_s: unknown, limit: number, url: string | null) => {
        started.push({ limit, url });
        return { runId: "run-1" };
      },
      collectEngagers: async () =>
        state === "running"
          ? { status: "running" }
          : { status: "done", usernames: ["user1", "user2", "user3"] },
    });
    const t = await setup([apify]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const { job } = await t.scrapers.startJob({
        projectId: p.id,
        source: parseSource("https://instagram.com/bigcoach", "followers"),
        limit: 900,
      });
      await t.scrapers.drain({ budgetMs: 5_000 });
      expect(started).toEqual([{ limit: 900, url: null }]);
      expect((await t.scrapers.getJob(job.id)).status).toBe("running");
      // Still running: nothing changes.
      expect(await t.scrapers.collectDiscoveryRuns("run-1")).toBe(0);
      state = "done";
      expect(await t.scrapers.collectDiscoveryRuns("run-1")).toBe(1);
      // A second report of the same run is ignored.
      expect(await t.scrapers.collectDiscoveryRuns("run-1")).toBe(0);
      for (let i = 0; i < 10; i++) await t.scrapers.drain({ budgetMs: 5_000 });
      const done = await t.scrapers.getJob(job.id);
      expect(done.status).toBe("done");
      expect(done.counts).toMatchObject({ discovered: 3, enriched: 3 });
    } finally {
      await t.close();
    }
  });

  it("keeps a free provider first: no batch when it reads one account at a time", async () => {
    const worker = new FakeProvider("worker", ["profile"], { profile: fakeProfile });
    const apify = new FakeProvider("apify", ["profile"], { profile: fakeProfile });
    let batched = 0;
    Object.assign(apify, {
      getProfiles: async () => {
        batched++;
        return [];
      },
    });
    const t = await setup([worker, apify]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await runJob(t, p.id, ["user1", "user2", "user3"]);
      expect(batched).toBe(0);
      expect(worker.calls).toBe(3);
    } finally {
      await t.close();
    }
  });

  it("falls back when a provider is rate limited and counts failures", async () => {
    const limited = new FakeProvider("worker", ["profile"], {
      profile: () => {
        throw new RateLimitedError("429", "worker");
      },
    });
    const backup = new FakeProvider("apify", ["profile"], {
      profile: (u) => {
        if (u === "ghost") throw new NotFoundError("gone", "apify");
        if (u === "broken") throw new Error("boom");
        return fakeProfile(u);
      },
    });
    const t = await setup([limited, backup]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const job = await runJob(t, p.id, ["user1", "ghost", "broken", "user2"]);
      expect(job.status).toBe("done");
      expect(job.counts).toMatchObject({ discovered: 4, enriched: 2, skipped: 1, failed: 1 });
      expect(limited.calls).toBe(1); // rested after the first 429
      const rows = await t.scrapers.listLeads({ projectId: p.id });
      expect(rows.map((r) => r.username).sort()).toEqual(["user1", "user2"]);
    } finally {
      await t.close();
    }
  });

  it("skips suppressed usernames, emails and phones and deletes existing data", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await runJob(t, p.id, ["user1", "user4", "user5"]);
      expect(await t.scrapers.listLeads({ projectId: p.id })).toHaveLength(3);

      await t.scrapers.suppress("email", "USER5@example-fx.com");
      await t.scrapers.suppress("phone", "00966 50 100 0004");
      await t.scrapers.suppress("username", "@User1");
      expect(await t.scrapers.listLeads({ projectId: p.id })).toHaveLength(0);

      const again = await runJob(t, p.id, ["user1", "user4", "user5", "user8"]);
      expect(again.counts).toMatchObject({ discovered: 4, skipped: 3, enriched: 1 });
      expect((await t.scrapers.listLeads({ projectId: p.id })).map((r) => r.username)).toEqual([
        "user8",
      ]);
    } finally {
      await t.close();
    }
  });

  it("filters leads", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      await runJob(t, p.id, usernames(8));
      expect(await t.scrapers.listLeads({ projectId: p.id, business: true })).toHaveLength(6);
      expect(await t.scrapers.listLeads({ projectId: p.id, hasEmail: true })).toHaveLength(2);
      expect(await t.scrapers.listLeads({ projectId: p.id, hasPhone: true })).toHaveLength(2);
      expect(await t.scrapers.listLeads({ projectId: p.id, limit: 3, offset: 6 })).toHaveLength(2);
      await t.db.update(leadsTable).set({ aiScore: 80 });
      expect(await t.scrapers.listLeads({ projectId: p.id, minScore: 70 })).toHaveLength(8);
      expect(await t.scrapers.listLeads({ projectId: p.id, minScore: 90 })).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("discovers engagers through a provider and records which one", async () => {
    const apify = new FakeProvider(
      "apify",
      ["account_engagers"],
      { engagers: () => ["User1", "user2", "user1"] },
      6000,
      2.5,
    );
    const worker = new FakeProvider("worker", ["profile"], { profile: fakeProfile });
    const t = await setup([apify, worker]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const source = parseSource("https://instagram.com/competitor");
      expect(t.scrapers.estimateCost(source, 1000)).toBe(2.5);
      const { job } = await t.scrapers.startJob({ projectId: p.id, source, limit: 10 });
      await t.scrapers.handlers.discover({ jobId: job.id });
      const j = await t.scrapers.getJob(job.id);
      expect(j).toMatchObject({ status: "running", provider: "apify", counts: { discovered: 2 } });
      expect(j.progress).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("runs a followers job end to end and keeps its source after a reload", async () => {
    const followers = new FakeProvider("apify", ["account_followers"], {
      engagers: () => ["f1", "f2", "f3"],
    });
    const engagersOnly = new FakeProvider("graph", ["account_engagers"], {
      engagers: () => ["commenter"],
    });
    const worker = new FakeProvider("worker", ["profile"], { profile: fakeProfile });
    const t = await setup([engagersOnly, followers, worker]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const source = parseSource("https://www.instagram.com/competitor/followers/");
      const { job } = await t.scrapers.startJob({ projectId: p.id, source, limit: 10 });
      // Stored in the database with the new enum value, then read back for discovery.
      for (let i = 0; i < 10; i++) {
        const r = await t.scrapers.drain({ budgetMs: 5_000 });
        if (r.activeJobs === 0) break;
      }
      const j = await t.scrapers.getJob(job.id);
      expect(j).toMatchObject({
        status: "done",
        sourceType: "followers",
        provider: "apify",
        counts: { discovered: 3, enriched: 3 },
      });
      const leads = await t.scrapers.listLeads({ projectId: p.id });
      expect(leads.map((l) => l.username).sort()).toEqual(["f1", "f2", "f3"]);
    } finally {
      await t.close();
    }
  });

  it("fails a job with a helpful message when no provider can discover", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const { job } = await t.scrapers.startJob({
        projectId: p.id,
        source: parseSource("#forex"),
        limit: 10,
      });
      await t.scrapers.handlers.discover({ jobId: job.id });
      const j = await t.scrapers.getJob(job.id);
      expect(j.status).toBe("failed");
      expect(j.error).toMatch(/upload a CSV/);
    } finally {
      await t.close();
    }
  });

  it("finishes empty jobs, honours cancellation and caps the limit", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      expect((await runJob(t, p.id, [])).status).toBe("done");

      const { job } = await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(usernames(5)),
        limit: 99_999,
      });
      expect(job.limit).toBe(1000);
      await t.scrapers.handlers.discover({ jobId: job.id, usernames: usernames(5) });
      expect((await t.scrapers.cancelJob(job.id)).status).toBe("cancelled");
      await t.scrapers.handlers.enrich({ jobId: job.id, usernames: usernames(5) });
      expect((await t.scrapers.getJob(job.id)).counts.enriched).toBeUndefined();
      // Cancelling a finished job leaves it as it is.
      expect((await t.scrapers.cancelJob(job.id)).status).toBe("cancelled");
      await expect(t.scrapers.getJob("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
        /not found/,
      );
    } finally {
      await t.close();
    }
  });

  it("deletes expired leads and orphaned profiles", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o", retentionDays: 30 });
      await runJob(t, p.id, ["user1", "user2"]);
      await t.db.update(leadsTable).set({ expiresAt: new Date(Date.now() - 1000) });
      await t.scrapers.handlers.retention();
      expect(await t.scrapers.listLeads({ projectId: p.id })).toHaveLength(0);
      const { rows } = await t.pg.query<{ n: number }>("select count(*)::int as n from profiles");
      expect(rows[0]?.n).toBe(0);
    } finally {
      await t.close();
    }
  });
});
