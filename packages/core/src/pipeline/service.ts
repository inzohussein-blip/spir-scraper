import { type AnyDb, jobs, leads, profiles, projects, suppression } from "@scrapers/db";
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { extractContact } from "../extract/index.js";
import { type SuppressionKind, suppressionHash } from "../suppression.js";
import { NotFoundError, type RawProfile, type Source } from "../types.js";
import type { ProviderRouter } from "./router.js";

export const QUEUES = {
  discover: "scrapers-discover",
  enrich: "scrapers-enrich",
  retention: "scrapers-retention",
} as const;

export const ENRICH_BATCH = 50;

export interface ScrapersConfig {
  suppressionPepper: string;
  maxJobLimit?: number;
  defaultRetentionDays?: number;
}

export interface DiscoverPayload {
  jobId: string;
  /** Only for upload sources: the usernames read from the CSV. */
  usernames?: string[];
}

export interface EnrichPayload {
  jobId: string;
  usernames: string[];
}

export interface LeadFilters {
  projectId: string;
  jobId?: string;
  business?: boolean;
  hasEmail?: boolean;
  hasPhone?: boolean;
  minScore?: number;
  limit?: number;
  offset?: number;
}

/** A lead joined with its profile: what list_leads and the exporters return. */
export interface LeadRow {
  username: string;
  fullName: string | null;
  category: string | null;
  followers: number | null;
  isBusiness: boolean;
  email: string | null;
  phone: string | null;
  phoneCountry: string | null;
  phoneConfirmed: boolean;
  contactSource: string | null;
  aiScore: number | null;
  aiTags: string[] | null;
  aiReason: string | null;
  sourceUrl: string;
  fetchedAt: Date;
}

export class JobNotFoundError extends Error {
  override name = "JobNotFoundError";
}

export function createScrapers(deps: {
  db: AnyDb;
  boss: PgBoss;
  router: ProviderRouter;
  config: ScrapersConfig;
}) {
  const { db, boss, router, config } = deps;
  const maxLimit = config.maxJobLimit ?? 1000;

  async function bump(jobId: string, delta: Record<string, number>) {
    const parts = Object.entries(delta)
      .filter(([, n]) => n !== 0)
      .map(
        ([k, n]) =>
          sql`jsonb_build_object(${k}::text, coalesce((${jobs.counts}->>${k})::int, 0) + ${n}::int)`,
      );
    if (parts.length === 0) return;
    const merged = parts.reduce((acc, p) => sql`${acc} || ${p}`);
    await db
      .update(jobs)
      .set({ counts: sql`${jobs.counts} || ${merged}` })
      .where(eq(jobs.id, jobId));
  }

  /** Marks a running job done once every discovered account is accounted for. */
  async function finishIfComplete(jobId: string) {
    await db
      .update(jobs)
      .set({ status: "done", finishedAt: new Date() })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, "running"),
          sql`coalesce((${jobs.counts}->>'enriched')::int, 0) + coalesce((${jobs.counts}->>'skipped')::int, 0)
            + coalesce((${jobs.counts}->>'failed')::int, 0) >= coalesce((${jobs.counts}->>'discovered')::int, 0)`,
        ),
      );
  }

  async function isSuppressed(
    kind: SuppressionKind,
    value: string | null | undefined,
  ): Promise<boolean> {
    if (!value) return false;
    const [hit] = await db
      .select({ h: suppression.valueHash })
      .from(suppression)
      .where(eq(suppression.valueHash, suppressionHash(kind, value, config.suppressionPepper)))
      .limit(1);
    return !!hit;
  }

  async function saveProfile(p: RawProfile, fetchedBy: "graph" | "apify" | "worker") {
    // A username can move to a new account; drop the stale row first.
    await db
      .delete(profiles)
      .where(
        and(eq(profiles.username, p.username.toLowerCase()), ne(profiles.igUserId, p.igUserId)),
      );
    const values = {
      igUserId: p.igUserId,
      username: p.username.toLowerCase(),
      fullName: p.fullName ?? null,
      bio: p.bio ?? null,
      followers: p.followers ?? null,
      following: p.following ?? null,
      posts: p.posts ?? null,
      isBusiness: p.isBusiness,
      isVerified: p.isVerified,
      category: p.category ?? null,
      externalUrl: p.externalUrl ?? null,
      fetchedAt: new Date(),
      fetchedBy,
    };
    await db
      .insert(profiles)
      .values(values)
      .onConflictDoUpdate({ target: profiles.igUserId, set: values });
  }

  async function handleDiscover(payload: DiscoverPayload) {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, payload.jobId));
    if (job?.status !== "queued") return;
    await db
      .update(jobs)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(jobs.id, job.id));

    let usernames: string[];
    try {
      if (job.sourceType === "upload") {
        usernames = (payload.usernames ?? []).slice(0, job.limit);
      } else {
        const source = sourceFromJob(job);
        const found = await router.listEngagers(source, job.limit);
        usernames = found.usernames;
        await db.update(jobs).set({ provider: found.provider }).where(eq(jobs.id, job.id));
      }
    } catch (err) {
      await db
        .update(jobs)
        .set({ status: "failed", error: (err as Error).message, finishedAt: new Date() })
        .where(eq(jobs.id, job.id));
      return;
    }

    await db
      .update(jobs)
      .set({ counts: { discovered: usernames.length } })
      .where(eq(jobs.id, job.id));
    if (usernames.length === 0) {
      await finishIfComplete(job.id);
      return;
    }
    const batches: { data: EnrichPayload }[] = [];
    for (let i = 0; i < usernames.length; i += ENRICH_BATCH) {
      batches.push({ data: { jobId: job.id, usernames: usernames.slice(i, i + ENRICH_BATCH) } });
    }
    await boss.insert(QUEUES.enrich, batches);
  }

  async function handleEnrich(payload: EnrichPayload) {
    const [row] = await db
      .select({ job: jobs, retentionDays: projects.retentionDays })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .where(eq(jobs.id, payload.jobId));
    if (row?.job.status !== "running") return;
    const { job, retentionDays } = row;
    const expiresAt = new Date(Date.now() + retentionDays * 86_400_000);

    for (const username of payload.usernames) {
      // Re-check between accounts so cancelling takes effect quickly.
      const [current] = await db
        .select({ status: jobs.status })
        .from(jobs)
        .where(eq(jobs.id, job.id));
      if (current?.status !== "running") return;

      if (await isSuppressed("username", username)) {
        await bump(job.id, { skipped: 1 });
        continue;
      }
      let fetched: Awaited<ReturnType<ProviderRouter["getProfile"]>>;
      try {
        fetched = await router.getProfile(username);
      } catch (err) {
        await bump(job.id, err instanceof NotFoundError ? { skipped: 1 } : { failed: 1 });
        continue;
      }
      const contact = extractContact(fetched.profile);
      if (
        (await isSuppressed("email", contact.email)) ||
        (await isSuppressed("phone", contact.phoneE164 ?? contact.phoneRaw))
      ) {
        await bump(job.id, { skipped: 1 });
        continue;
      }
      await saveProfile(fetched.profile, fetched.provider);
      const leadValues = {
        jobId: job.id,
        email: contact.email,
        phoneE164: contact.phoneE164,
        phoneRaw: contact.phoneRaw,
        phoneCountry: contact.phoneCountry,
        contactSource: contact.contactSource,
        expiresAt,
      };
      await db
        .insert(leads)
        .values({ projectId: job.projectId, profileId: fetched.profile.igUserId, ...leadValues })
        .onConflictDoUpdate({ target: [leads.projectId, leads.profileId], set: leadValues });
      const hasContact = !!(contact.email || contact.phoneE164 || contact.phoneRaw);
      await bump(job.id, { enriched: 1, leads: hasContact ? 1 : 0 });
    }
    await finishIfComplete(job.id);
  }

  async function handleRetention() {
    const now = new Date();
    await db.delete(leads).where(lt(leads.expiresAt, now));
    // Profiles no lead points to any more.
    await db
      .delete(profiles)
      .where(
        notExists(
          db.select({ one: sql`1` }).from(leads).where(eq(leads.profileId, profiles.igUserId)),
        ),
      );
  }

  return {
    async init() {
      await boss.createQueue(QUEUES.discover, {
        retryLimit: 2,
        retryBackoff: true,
        retryDelay: 30,
      });
      await boss.createQueue(QUEUES.enrich, { retryLimit: 3, retryBackoff: true, retryDelay: 30 });
      await boss.createQueue(QUEUES.retention);
    },

    /** Starts consuming queues. Call once per worker process. */
    async work(opts: { pollingIntervalSeconds?: number } = {}) {
      const polling = { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 };
      await boss.work<DiscoverPayload>(QUEUES.discover, polling, async ([job]) => {
        if (job) await handleDiscover(job.data);
      });
      await boss.work<EnrichPayload>(
        QUEUES.enrich,
        { ...polling, localConcurrency: 1 },
        async ([job]) => {
          if (job) await handleEnrich(job.data);
        },
      );
      await boss.work(QUEUES.retention, polling, async () => handleRetention());
      await boss.schedule(QUEUES.retention, "17 3 * * *");
    },

    async createProject(input: {
      name: string;
      owner: string;
      sheetId?: string;
      aiCriteria?: string;
      retentionDays?: number;
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

    estimateCost(source: Source, limit: number) {
      return router.estimateCost(source, Math.min(limit, maxLimit));
    },

    async startJob(input: { projectId: string; source: Source; limit: number }) {
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
      const payload: DiscoverPayload = { jobId: job.id };
      if (input.source.type === "upload")
        payload.usernames = input.source.usernames.slice(0, limit);
      await boss.send(QUEUES.discover, payload);
      return { job, estimatedCostUsd: router.estimateCost(input.source, limit) };
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
      return this.getJob(jobId);
    },

    async listLeads(f: LeadFilters): Promise<LeadRow[]> {
      const conds = [eq(leads.projectId, f.projectId)];
      if (f.jobId) conds.push(eq(leads.jobId, f.jobId));
      if (f.business) conds.push(eq(profiles.isBusiness, true));
      if (f.hasEmail) conds.push(isNotNull(leads.email));
      if (f.hasPhone) {
        const c = or(isNotNull(leads.phoneE164), isNotNull(leads.phoneRaw));
        if (c) conds.push(c);
      }
      if (f.minScore !== undefined) conds.push(gte(leads.aiScore, f.minScore));
      const rows = await db
        .select({ lead: leads, profile: profiles, sourceUrl: jobs.sourceUrl })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .innerJoin(jobs, eq(jobs.id, leads.jobId))
        .where(and(...conds))
        .orderBy(sql`${leads.aiScore} desc nulls last`, desc(profiles.followers), leads.id)
        .limit(Math.min(f.limit ?? 50, 5000))
        .offset(f.offset ?? 0);
      return rows.map(({ lead, profile, sourceUrl }) => ({
        username: profile.username,
        fullName: profile.fullName,
        category: profile.category,
        followers: profile.followers,
        isBusiness: profile.isBusiness,
        email: lead.email,
        phone: lead.phoneE164 ?? lead.phoneRaw,
        phoneCountry: lead.phoneCountry,
        phoneConfirmed: !!lead.phoneE164,
        contactSource: lead.contactSource,
        aiScore: lead.aiScore,
        aiTags: lead.aiTags,
        aiReason: lead.aiReason,
        sourceUrl,
        fetchedAt: profile.fetchedAt,
      }));
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
        const all = await db
          .select({ id: leads.id, e164: leads.phoneE164, raw: leads.phoneRaw })
          .from(leads)
          .where(or(isNotNull(leads.phoneE164), isNotNull(leads.phoneRaw)));
        const ids = all
          .filter(
            (l) =>
              suppressionHash("phone", l.e164 ?? l.raw ?? "", config.suppressionPepper) ===
              valueHash,
          )
          .map((l) => l.id);
        if (ids.length) await db.delete(leads).where(inArray(leads.id, ids));
      }
    },

    /** Exposed for tests and for running the pipeline without pg-boss workers. */
    handlers: { discover: handleDiscover, enrich: handleEnrich, retention: handleRetention },
  };
}

export type Scrapers = ReturnType<typeof createScrapers>;

function sourceFromJob(job: {
  sourceType: string;
  sourceUrl: string;
}): Exclude<Source, { type: "upload" }> {
  const parts = new URL(job.sourceUrl).pathname.split("/").filter(Boolean);
  if (job.sourceType === "post")
    return { type: "post", shortcode: parts[1] ?? "", url: job.sourceUrl };
  if (job.sourceType === "hashtag")
    return { type: "hashtag", tag: decodeURIComponent(parts[2] ?? ""), url: job.sourceUrl };
  return { type: "profile", username: parts[0] ?? "", url: job.sourceUrl };
}
