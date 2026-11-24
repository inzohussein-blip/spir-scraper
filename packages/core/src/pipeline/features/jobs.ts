import { jobs, leads, profiles, projects, suppression } from "@scrapers/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AudienceStats } from "../../scoring.js";
import { type SuppressionKind, suppressionHash } from "../../suppression.js";
import type { Source } from "../../types.js";
import type { Core } from "../core.js";
import { type DiscoverPayload, JobNotFoundError, QUEUES } from "../core.js";

import type { CoreSelf } from "./context.js";

/** Projects and collection jobs: create, start, follow, cancel, suppress, audience report. */
export function jobsMethods(core: Core, api: () => CoreSelf) {
  const { db, boss, router, config, scorer, setValue, maxLimit } = core;

  return {
    async createProject(input: {
      name: string;
      owner: string;
      sheetId?: string;
      aiCriteria?: string;
      retentionDays?: number;
      autoExport?: boolean;
      watchKeywords?: string[];
    }) {
      const [p] = await db
        .insert(projects)
        .values({
          ...input,
          retentionDays: input.retentionDays ?? config.defaultRetentionDays ?? 90,
        })
        .returning();
      if (!p) throw new Error("Project insert returned nothing");
      return p;
    },

    async listProjects() {
      return db.select().from(projects).orderBy(desc(projects.createdAt));
    },

    estimateCost(source: Source, limit: number, opts: { enrich?: boolean } = {}) {
      return router.estimateCost(source, Math.min(limit, maxLimit), opts);
    },

    async startJob(input: {
      projectId: string;
      source: Source;
      limit: number;
      /**
       * Who reads the accounts: Apify and the other providers (fast, paid),
       * the Spir engine (free, slower), or auto: the engine when a device has
       * been in touch in the last hour.
       */
      readVia?: "auto" | "providers" | "engine";
    }) {
      const limit = Math.min(Math.max(1, Math.floor(input.limit)), maxLimit);
      const [job] = await db
        .insert(jobs)
        .values({
          projectId: input.projectId,
          sourceType: input.source.type,
          sourceUrl: input.source.url,
          limit,
          ...(input.source.type === "upload" ? { provider: "upload" as const } : {}),
        })
        .returning();
      if (!job) throw new Error("Job insert returned nothing");
      const via =
        input.readVia === "engine"
          ? "engine"
          : input.readVia === "auto" && (await api().engineOnline())
            ? "engine"
            : "providers";
      if (via === "engine") await setValue(`job-read:${job.id}`, "engine", 30 * 86_400_000);
      const payload: DiscoverPayload = { jobId: job.id };
      if (input.source.type === "upload")
        payload.usernames = input.source.usernames.slice(0, limit);
      await boss.send(QUEUES.discover, payload);
      return {
        job,
        readVia: via,
        estimatedCostUsd: router.estimateCost(input.source, limit, { enrich: via !== "engine" }),
      };
    },

    async getJob(jobId: string) {
      const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      if (!job) throw new JobNotFoundError(`Job ${jobId} not found`);
      const c = job.counts;
      const done = (c.enriched ?? 0) + (c.skipped ?? 0) + (c.failed ?? 0);
      const progress = job.status === "done" ? 1 : c.discovered ? done / c.discovered : 0;
      return { ...job, progress: Math.min(1, progress) };
    },

    async cancelJob(jobId: string) {
      await db
        .update(jobs)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["queued", "running"])));
      return api().getJob(jobId);
    },

    /** Adds to the suppression list and deletes any matching data. */
    async suppress(kind: SuppressionKind, value: string, reason?: string) {
      const valueHash = suppressionHash(kind, value, config.suppressionPepper);
      await db
        .insert(suppression)
        .values({ valueHash, kind, reason: reason ?? null })
        .onConflictDoNothing();
      if (kind === "username") {
        await db
          .delete(profiles)
          .where(eq(profiles.username, value.trim().replace(/^@/, "").toLowerCase()));
      } else if (kind === "email") {
        await db.delete(leads).where(eq(leads.email, value.trim().toLowerCase()));
      } else {
        await db.delete(leads).where(eq(leads.phoneHash, valueHash));
      }
    },

    async getProject(projectId: string) {
      const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
      return p ?? null;
    },

    async listJobs(opts: { projectId?: string; limit?: number } = {}) {
      return db
        .select()
        .from(jobs)
        .where(opts.projectId ? eq(jobs.projectId, opts.projectId) : undefined)
        .orderBy(desc(jobs.createdAt))
        .limit(Math.min(opts.limit ?? 20, 200));
    },

    /** A stored public profile and where it was collected. */
    async getStoredProfile(username: string) {
      const [p] = await db
        .select()
        .from(profiles)
        .where(eq(profiles.username, username.trim().replace(/^@/, "").toLowerCase()));
      if (!p) return null;
      const sources = await db
        .select({
          projectId: leads.projectId,
          jobId: leads.jobId,
          sourceUrl: jobs.sourceUrl,
          contactSource: leads.contactSource,
        })
        .from(leads)
        .innerJoin(jobs, eq(jobs.id, leads.jobId))
        .where(eq(leads.profileId, p.igUserId));
      return { ...p, sources };
    },

    get scoringAvailable() {
      return !!scorer;
    },

    /** Audience summary for a job; written by the AI when available. */
    async audienceReport(jobId: string) {
      const rows = await db
        .select({ lead: leads, profile: profiles })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(eq(leads.jobId, jobId));
      const count = (vals: (string | undefined)[]) => {
        const out: Record<string, number> = {};
        for (const v of vals) if (v) out[v] = (out[v] ?? 0) + 1;
        return out;
      };
      const stats: AudienceStats = {
        total: rows.length,
        segments: count(rows.map((r) => r.lead.aiTags?.[0])),
        languages: count(rows.map((r) => r.lead.aiTags?.[1])),
        countries: count(rows.map((r) => r.lead.phoneCountry ?? r.lead.aiTags?.[2])),
        top: rows
          .filter((r) => r.lead.aiScore !== null)
          .sort((a, b) => (b.lead.aiScore ?? 0) - (a.lead.aiScore ?? 0))
          .slice(0, 20)
          .map((r) => ({
            username: r.profile.username,
            followers: r.profile.followers,
            segment: r.lead.aiTags?.[0] ?? "",
            score: r.lead.aiScore ?? 0,
          })),
      };
      const [job] = await db.select({ counts: jobs.counts }).from(jobs).where(eq(jobs.id, jobId));
      let report: string | undefined;
      if (scorer?.report && stats.top.length > 0) {
        report = await scorer.report(stats, job?.counts.aiCriteria ?? "");
        await db
          .update(jobs)
          .set({ counts: sql`${jobs.counts} || ${JSON.stringify({ report })}::jsonb` })
          .where(eq(jobs.id, jobId));
      }
      return { stats, report };
    },
  };
}
