import { describe, expect, it } from "vitest";
import { uploadSource } from "../src/source.js";
import { FakeProvider, FakeScorer, fakeProfile, setup } from "./helpers.js";

const names = (n: number) => Array.from({ length: n }, (_, i) => `user${i + 1}`);
const worker = () => new FakeProvider("worker", ["profile"], { profile: fakeProfile });

describe("drain (serverless processing)", () => {
  it("processes queued jobs within a time budget and reports remaining work", async () => {
    const t = await setup([worker()]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const { job } = await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(names(120)),
        limit: 500,
      });
      // A tiny budget stops after the first fetched job.
      const first = await t.scrapers.drain({ budgetMs: 1 });
      expect(first.processed).toBeGreaterThanOrEqual(1);
      let r = first;
      for (let i = 0; i < 20 && r.activeJobs > 0; i++)
        r = await t.scrapers.drain({ budgetMs: 5_000 });
      expect(r).toMatchObject({ activeJobs: 0, more: false });
      expect((await t.scrapers.getJob(job.id)).counts).toMatchObject({
        discovered: 120,
        enriched: 120,
      });
      expect((await t.scrapers.listJobs({ projectId: p.id }))[0]?.id).toBe(job.id);
    } finally {
      await t.close();
    }
  });
});

describe("AI scoring", () => {
  it("scores small jobs right away and builds a report", async () => {
    const t = await setup([worker()], new FakeScorer(100));
    try {
      expect(t.scrapers.scoringAvailable).toBe(true);
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const { job } = await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(names(8)),
        limit: 10,
      });
      while ((await t.scrapers.drain({ budgetMs: 5_000 })).activeJobs > 0);
      expect(await t.scrapers.scoreLeads(job.id, "partners")).toEqual({ mode: "now", count: 8 });
      expect(await t.scrapers.scoreLeads(job.id, "partners")).toEqual({ mode: "none", count: 0 });
      const top = await t.scrapers.listLeads({ projectId: p.id, minScore: 10 });
      expect(top[0]).toMatchObject({
        username: "user8",
        aiScore: 11,
        aiTags: ["potential_partner", "ar", "SA"],
      });
      const { stats, report } = await t.scrapers.audienceReport(job.id);
      expect(stats.segments).toEqual({ potential_partner: 6, individual_trader: 2 });
      expect(report).toBe("report for 8");
      expect((await t.scrapers.getJob(job.id)).counts).toMatchObject({
        scored: 8,
        report: "report for 8",
      });
    } finally {
      await t.close();
    }
  });

  it("submits large jobs as a batch and collects them later", async () => {
    const scorer = new FakeScorer(3);
    const t = await setup([worker()], scorer);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const { job } = await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(names(5)),
        limit: 10,
      });
      while ((await t.scrapers.drain({ budgetMs: 5_000 })).activeJobs > 0);
      expect(await t.scrapers.scoreLeads(job.id, "x")).toMatchObject({
        mode: "batch",
        count: 5,
        batchId: "batch_1",
      });
      await t.scrapers.drain({ budgetMs: 100 });
      expect((await t.scrapers.getJob(job.id)).counts.aiBatchId).toBe("batch_1");
      const batch = scorer.batches.get("batch_1");
      if (batch) batch.ready = true;
      await t.scrapers.handlers.retention();
      const counts = (await t.scrapers.getJob(job.id)).counts;
      expect(counts.aiBatchId).toBeUndefined();
      expect(counts.scored).toBe(5);
    } finally {
      await t.close();
    }
  });

  it("explains when scoring is not configured", async () => {
    const t = await setup([worker()]);
    try {
      expect(t.scrapers.scoringAvailable).toBe(false);
      await expect(t.scrapers.scoreLeads("x", "y")).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      await t.close();
    }
  });
});

describe("API keys and lookups", () => {
  it("creates, verifies and revokes keys without storing them", async () => {
    const t = await setup([worker()]);
    try {
      const k = await t.scrapers.createApiKey("n8n", ["read", "write"]);
      expect(k.key).toMatch(/^sk_/);
      const { rows } = await t.pg.query<{ key_hash: string }>("select key_hash from api_keys");
      expect(rows[0]?.key_hash).not.toContain(k.key);
      expect(await t.scrapers.verifyApiKey(k.key)).toEqual({ id: k.id, scopes: ["read", "write"] });
      expect(await t.scrapers.verifyApiKey("sk_wrong")).toBeNull();
      expect(await t.scrapers.verifyApiKey("nope")).toBeNull();
      expect((await t.scrapers.listApiKeys())[0]?.lastUsed).toBeInstanceOf(Date);
      await t.scrapers.revokeApiKey(k.id);
      expect(await t.scrapers.verifyApiKey(k.key)).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("returns stored profiles with their sources", async () => {
    const t = await setup([worker()]);
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      expect(await t.scrapers.getProject(p.id)).toMatchObject({ name: "p" });
      expect(await t.scrapers.getProject("00000000-0000-0000-0000-000000000000")).toBeNull();
      await t.scrapers.startJob({ projectId: p.id, source: uploadSource(["user1"]), limit: 1 });
      while ((await t.scrapers.drain({ budgetMs: 5_000 })).activeJobs > 0);
      const prof = await t.scrapers.getStoredProfile("@User1");
      expect(prof).toMatchObject({
        username: "user1",
        sources: [{ sourceUrl: "upload.csv", contactSource: "bio" }],
      });
      expect(await t.scrapers.getStoredProfile("missing")).toBeNull();
    } finally {
      await t.close();
    }
  });
});
