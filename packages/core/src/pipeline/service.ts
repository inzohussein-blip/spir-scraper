import { createHash, randomBytes } from "node:crypto";
import {
  type AnyDb,
  apiKeys,
  auditLog,
  counters,
  ephemeral,
  jobs,
  type LeadStatus,
  leads,
  monitors,
  notifications,
  profiles,
  projects,
  pushSubscriptions,
  suppression,
} from "@scrapers/db";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  createMxChecker,
  fetchLinkPage,
  profileQuality,
  type ResolveDeps,
  resolveContact,
} from "../extract/index.js";
import { type NotificationInput, type NotificationSink, redactSecrets } from "../notify.js";
import type { AudienceStats, LeadScore, Scorer, ScoringInput } from "../scoring.js";
import { type SuppressionKind, suppressionHash } from "../suppression.js";
import { NotFoundError, type RawProfile, type Source } from "../types.js";
import { NoProviderError, type ProviderRouter } from "./router.js";

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
  /** Reuse a profile fetched within this many days instead of fetching it again (0 disables). */
  profileCacheDays?: number;
  /** Weekly summary day (0 = Sunday … 5 = Friday) and time zone. */
  weeklyDay?: number;
  timeZone?: string;
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
  status?: LeadStatus;
  /** Text search in username, name and bio. */
  q?: string;
  limit?: number;
  offset?: number;
  /** Opaque cursor from a previous page (keyset pagination). */
  cursor?: string;
}

export const LEAD_STATUSES: readonly LeadStatus[] = [
  "new",
  "contacted",
  "interested",
  "customer",
  "rejected",
];

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
  status: LeadStatus;
  statusNote: string | null;
  city: string | null;
  engagementRate: number | null;
  qualityFlags: string[] | null;
  /** How many other projects also hold this person. */
  otherProjects: number;
  sourceUrl: string;
  fetchedAt: Date;
  /** When the owner asked to be reminded to follow up. */
  followUpAt?: Date | null;
}

/** Lead statuses in Arabic, for reminders. */
const STATUS_AR: Record<string, string> = {
  new: "جديد",
  contacted: "تواصلت",
  interested: "مهتم",
  customer: "عميل",
  rejected: "مرفوض",
};

export class JobNotFoundError extends Error {
  override name = "JobNotFoundError";
}

export class ScoringUnavailableError extends Error {
  override name = "ScoringUnavailableError";
}

export type ApiScope = "read" | "write";

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function createScrapers(deps: {
  db: AnyDb;
  boss: PgBoss;
  router: ProviderRouter;
  config: ScrapersConfig;
  /** Optional AI scorer (needs ANTHROPIC_API_KEY). */
  scorer?: Scorer | undefined;
  /** Extra places notifications go, e.g. Telegram. */
  sinks?: NotificationSink[];
  /** Public dashboard URL, used to build links in notifications. */
  appUrl?: string;
  /** Network steps of contact extraction (link-in-bio pages, MX check). Defaults to the real ones. */
  resolve?: ResolveDeps;
  /** Called when a finished job (scored, if the project has AI criteria) is ready to export. */
  onReadyToExport?: (jobId: string) => Promise<void>;
}) {
  const { db, boss, router, config, scorer } = deps;
  const sinks = deps.sinks ?? [];
  const resolveDeps: ResolveDeps = deps.resolve ?? {
    linkPage: (url) => fetchLinkPage(url),
    checkEmail: createMxChecker(),
  };
  const cacheDays = config.profileCacheDays ?? 30;
  const pepper = config.suppressionPepper;

  // ---- small shared stores (serverless-safe) ----
  async function getValue<T>(key: string): Promise<T | null> {
    const [row] = await db
      .select({ value: ephemeral.value })
      .from(ephemeral)
      .where(and(eq(ephemeral.key, key), sql`${ephemeral.expiresAt} > now()`));
    return (row?.value as T | undefined) ?? null;
  }

  async function setValue(key: string, value: unknown, ttlMs: number) {
    const expiresAt = new Date(Date.now() + ttlMs);
    await db
      .insert(ephemeral)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: ephemeral.key, set: { value, expiresAt } });
  }

  /** Stores the key only if it is not there yet; false means it was already claimed. */
  async function claimOnce(key: string, ttlMs: number): Promise<boolean> {
    await db
      .delete(ephemeral)
      .where(and(eq(ephemeral.key, key), sql`${ephemeral.expiresAt} <= now()`));
    const rows = await db
      .insert(ephemeral)
      .values({ key, value: true, expiresAt: new Date(Date.now() + ttlMs) })
      .onConflictDoNothing()
      .returning({ key: ephemeral.key });
    return rows.length > 0;
  }

  /** Fixed-window counter: returns the count within the current window, including this hit. */
  async function hitCounter(key: string, windowMs: number): Promise<number> {
    const expiresAt = new Date(Date.now() + windowMs).toISOString();
    const [row] = await db
      .insert(counters)
      .values({ key, count: 1, expiresAt: new Date(expiresAt) })
      .onConflictDoUpdate({
        target: counters.key,
        set: {
          count: sql`case when ${counters.expiresAt} <= now() then 1 else ${counters.count} + 1 end`,
          expiresAt: sql`case when ${counters.expiresAt} <= now() then ${expiresAt}::timestamptz else ${counters.expiresAt} end`,
        },
      })
      .returning({ count: counters.count });
    return row?.count ?? 1;
  }

  const ROUTER_KEY = "router:state";
  async function loadRouterState() {
    router.restore(await getValue<Record<string, { until: number; down: boolean }>>(ROUTER_KEY));
  }
  async function saveRouterState() {
    await setValue(ROUTER_KEY, router.snapshot(), 24 * 3600_000);
  }

  /** Stores a bell notification (deduplicated for 30 minutes) and forwards it to the sinks. */
  async function notify(n: NotificationInput): Promise<boolean> {
    const key = n.key ?? `${n.type}:${n.title}`;
    const since = new Date(Date.now() - 30 * 60_000);
    const [recent] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.dedupeKey, key), gte(notifications.at, since)))
      .limit(1);
    if (recent) return false;
    const clean: NotificationInput = {
      ...n,
      title: redactSecrets(n.title).slice(0, 140),
      ...(n.body ? { body: redactSecrets(n.body).slice(0, 600) } : {}),
    };
    await db.insert(notifications).values({
      type: clean.type,
      level: clean.level,
      title: clean.title,
      body: clean.body ?? null,
      url: clean.url ?? null,
      dedupeKey: key,
    });
    const link =
      clean.url && deps.appUrl ? `${deps.appUrl.replace(/\/$/, "")}${clean.url}` : undefined;
    for (const sink of sinks) {
      await sink
        .send({ ...clean, ...(link ? { link } : {}) })
        .catch((err) => console.error("[notify]", redactSecrets(String(err))));
    }
    return true;
  }

  async function jobLabel(jobId: string) {
    const [row] = await db
      .select({ sourceUrl: jobs.sourceUrl, counts: jobs.counts, project: projects.name })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .where(eq(jobs.id, jobId));
    return row;
  }
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
    const finished = await db
      .update(jobs)
      .set({ status: "done", finishedAt: new Date() })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, "running"),
          sql`coalesce((${jobs.counts}->>'enriched')::int, 0) + coalesce((${jobs.counts}->>'skipped')::int, 0)
            + coalesce((${jobs.counts}->>'failed')::int, 0) >= coalesce((${jobs.counts}->>'discovered')::int, 0)`,
        ),
      )
      .returning({ id: jobs.id });
    if (finished.length === 0) return;
    const j = await jobLabel(jobId);
    if (!j) return;
    const c = j.counts;
    await notify({
      type: "job",
      level: (c.failed ?? 0) > (c.enriched ?? 0) ? "warn" : "ok",
      title: `انتهت مهمة ${j.project}`,
      body: `${j.sourceUrl}\nمكتشفة ${c.discovered ?? 0} · جُلبت ${c.enriched ?? 0} · بوسيلة تواصل ${c.leads ?? 0} · فشلت ${c.failed ?? 0}`,
      url: `/jobs/${jobId}`,
      key: `job-done:${jobId}`,
    });
    await afterJobDone(jobId);
  }

  /** Scores the job when its project has AI criteria, then hands it over for export. */
  async function afterJobDone(jobId: string) {
    const [row] = await db
      .select({ criteria: projects.aiCriteria })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .where(eq(jobs.id, jobId));
    if (scorer && row?.criteria) {
      try {
        const r = await scoreJob(jobId, row.criteria, {});
        if (r.mode === "batch") return; // exported when the batch is collected
      } catch (err) {
        console.error("[auto-score]", redactSecrets((err as Error).message));
      }
    }
    await readyToExport(jobId);
  }

  async function readyToExport(jobId: string) {
    if (!deps.onReadyToExport) return;
    try {
      await deps.onReadyToExport(jobId);
    } catch (err) {
      await notify({
        type: "job",
        level: "warn",
        title: "تعذّر التصدير التلقائي",
        body: redactSecrets((err as Error).message),
        url: `/jobs/${jobId}`,
        key: `auto-export-failed:${jobId}`,
      });
    }
  }

  /** Which of these hashes are on the suppression list (one query). */
  async function suppressedHashes(hashes: string[]): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    const rows = await db
      .select({ h: suppression.valueHash })
      .from(suppression)
      .where(inArray(suppression.valueHash, hashes));
    return new Set(rows.map((r) => r.h));
  }

  async function saveProfile(
    p: RawProfile,
    fetchedBy: "graph" | "apify" | "worker",
    quality: { engagementRate: number | null; flags: string[] },
  ) {
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
      businessEmail: p.businessEmail ?? null,
      businessPhone: p.businessPhone ?? null,
      businessPhoneCountryCode: p.businessPhoneCountryCode ?? null,
      businessWhatsapp: p.businessWhatsapp ?? null,
      city: p.city ?? null,
      engagementRate: quality.engagementRate === null ? null : String(quality.engagementRate),
      qualityFlags: quality.flags.length ? quality.flags : null,
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
      const label = await jobLabel(job.id);
      await notify({
        type: "job",
        level: "bad",
        title: `فشلت مهمة ${label?.project ?? ""}`.trim(),
        body: `${job.sourceUrl}\n${(err as Error).message}`,
        url: `/jobs/${job.id}`,
        key: `job-failed:${job.id}`,
      });
      return;
    }

    if (job.onlyNew && usernames.length > 0) {
      // Monitors collect only people the project does not have yet.
      const known = await db
        .select({ username: profiles.username })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(and(eq(leads.projectId, job.projectId), inArray(profiles.username, usernames)));
      const have = new Set(known.map((k) => k.username));
      usernames = usernames.filter((u) => !have.has(u));
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

  const rowToRaw = (r: typeof profiles.$inferSelect): RawProfile => ({
    igUserId: r.igUserId,
    username: r.username,
    fullName: r.fullName,
    bio: r.bio,
    followers: r.followers,
    following: r.following,
    posts: r.posts,
    isBusiness: r.isBusiness,
    isVerified: r.isVerified,
    category: r.category,
    externalUrl: r.externalUrl,
    businessEmail: r.businessEmail,
    businessPhone: r.businessPhone,
    businessPhoneCountryCode: r.businessPhoneCountryCode,
    businessWhatsapp: r.businessWhatsapp,
    city: r.city,
  });

  function matchKeywords(p: RawProfile, keywords: string[] | null): string[] {
    if (!keywords?.length) return [];
    const text = `${p.username} ${p.fullName ?? ""} ${p.bio ?? ""}`.toLowerCase();
    return keywords.filter((k) => k.trim() && text.includes(k.trim().toLowerCase()));
  }

  async function handleEnrich(payload: EnrichPayload) {
    const [row] = await db
      .select({ job: jobs, project: projects })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .where(eq(jobs.id, payload.jobId));
    if (row?.job.status !== "running") return;
    const { job, project } = row;
    const expiresAt = new Date(Date.now() + project.retentionDays * 86_400_000);
    await loadRouterState();

    // One query each for suppressed usernames and cached profiles, instead of per account.
    const names = payload.usernames.map((u) => u.toLowerCase());
    const blocked = await suppressedHashes(
      names.map((u) => suppressionHash("username", u, pepper)),
    );
    const cached = new Map<string, typeof profiles.$inferSelect>();
    if (cacheDays > 0) {
      const fresh = await db
        .select()
        .from(profiles)
        .where(
          and(
            inArray(profiles.username, names),
            gte(profiles.fetchedAt, new Date(Date.now() - cacheDays * 86_400_000)),
          ),
        );
      for (const p of fresh) cached.set(p.username, p);
    }

    const delta = { enriched: 0, leads: 0, skipped: 0, failed: 0, cached: 0 };
    const watchHits: string[] = [];
    let deferred: string[] = [];

    for (let i = 0; i < names.length; i++) {
      const username = names[i] as string;
      // Re-check every 10 accounts so cancelling takes effect quickly.
      if (i > 0 && i % 10 === 0) {
        const [current] = await db
          .select({ status: jobs.status })
          .from(jobs)
          .where(eq(jobs.id, job.id));
        if (current?.status !== "running") break;
      }
      if (blocked.has(suppressionHash("username", username, pepper))) {
        delta.skipped++;
        continue;
      }

      let profile: RawProfile;
      let provider: "graph" | "apify" | "worker";
      let quality: { engagementRate: number | null; flags: string[] };
      const hit = cached.get(username);
      if (hit) {
        profile = rowToRaw(hit);
        provider = hit.fetchedBy === "upload" ? "worker" : hit.fetchedBy;
        quality = {
          engagementRate: hit.engagementRate === null ? null : Number(hit.engagementRate),
          flags: hit.qualityFlags ?? [],
        };
        delta.cached++;
      } else {
        try {
          const fetched = await router.getProfile(username);
          profile = fetched.profile;
          provider = fetched.provider;
          quality = profileQuality(profile);
        } catch (err) {
          if (err instanceof NotFoundError) {
            delta.skipped++;
            continue;
          }
          if (err instanceof NoProviderError && router.exhausted("profile")) {
            // Every provider is resting: resume this account and the rest later instead of failing them.
            deferred = names.slice(i);
            break;
          }
          delta.failed++;
          continue;
        }
      }

      const contact = await resolveContact(profile, resolveDeps);
      const contactHashes = [
        contact.email ? suppressionHash("email", contact.email, pepper) : null,
        contact.phoneE164 || contact.phoneRaw
          ? suppressionHash("phone", (contact.phoneE164 ?? contact.phoneRaw) as string, pepper)
          : null,
      ].filter((h): h is string => !!h);
      if ((await suppressedHashes(contactHashes)).size > 0) {
        delta.skipped++;
        continue;
      }
      if (!hit) await saveProfile(profile, provider, quality);
      const phone = contact.phoneE164 ?? contact.phoneRaw;
      const leadValues = {
        jobId: job.id,
        email: contact.email,
        phoneE164: contact.phoneE164,
        phoneRaw: contact.phoneRaw,
        phoneCountry: contact.phoneCountry,
        contactSource: contact.contactSource,
        phoneHash: phone ? suppressionHash("phone", phone, pepper) : null,
        expiresAt,
      };
      // On conflict the lead's status and note are kept: only the data is refreshed.
      await db
        .insert(leads)
        .values({ projectId: job.projectId, profileId: profile.igUserId, ...leadValues })
        .onConflictDoUpdate({ target: [leads.projectId, leads.profileId], set: leadValues });
      delta.enriched++;
      if (contact.email || phone) delta.leads++;
      if (matchKeywords(profile, project.watchKeywords).length) watchHits.push(profile.username);
    }

    await bump(job.id, delta);
    await saveRouterState();
    if (deferred.length > 0) {
      const waitSeconds = Math.ceil(router.nextAvailableIn("profile") / 1000) + 5;
      await boss.send(
        QUEUES.enrich,
        { jobId: job.id, usernames: deferred },
        { startAfter: waitSeconds },
      );
      await notify({
        type: "provider",
        level: "warn",
        title: `أُجّل ${deferred.length} حساباً في مهمة ${project.name}`,
        body: `كل المصادر في فترة توقف. تكمل المهمة تلقائياً بعد حوالي ${Math.ceil(waitSeconds / 60)} دقيقة.`,
        url: `/jobs/${job.id}`,
        key: `deferred:${job.id}`,
      });
    }
    if (watchHits.length > 0) {
      await notify({
        type: "system",
        level: "info",
        title: `كلمات المراقبة: ${watchHits.length} حساب في ${project.name}`,
        body: watchHits
          .slice(0, 15)
          .map((u) => `@${u}`)
          .join("، "),
        url: `/leads?project=${project.id}&job=${job.id}`,
        key: `watch:${job.id}:${watchHits[0]}`,
      });
    }
    await finishIfComplete(job.id);
  }

  async function saveScores(scores: Map<string, LeadScore>) {
    for (const [leadId, sc] of scores) {
      const tags = [sc.segment, sc.language, sc.country].filter((t): t is string => !!t);
      await db
        .update(leads)
        .set({
          aiScore: Math.round(Math.min(100, Math.max(0, sc.score))),
          aiTags: tags,
          aiReason: sc.reason.slice(0, 300),
        })
        .where(eq(leads.id, leadId));
    }
  }

  /** Collects finished AI batches; returns how many jobs were updated. */
  async function collectPendingScores(): Promise<number> {
    if (!scorer) return 0;
    const pending = await db
      .select({ id: jobs.id, counts: jobs.counts })
      .from(jobs)
      .where(sql`${jobs.counts} ? 'aiBatchId'`);
    let updated = 0;
    for (const j of pending) {
      const batchId = j.counts.aiBatchId;
      if (!batchId) continue;
      const scores = await scorer.collectBatch(batchId);
      if (!scores) continue;
      await saveScores(scores);
      await notify({
        type: "ai",
        level: "ok",
        title: "اكتمل التقييم بالذكاء الاصطناعي",
        body: `قُيّم ${scores.size} حساباً`,
        url: `/jobs/${j.id}`,
        key: `ai-batch:${batchId}`,
      });
      await db
        .update(jobs)
        .set({
          counts: sql`(${jobs.counts} - 'aiBatchId') || jsonb_build_object('scored', coalesce((${jobs.counts}->>'scored')::int, 0) + ${scores.size}::int)`,
        })
        .where(eq(jobs.id, j.id));
      updated++;
      await readyToExport(j.id);
    }
    return updated;
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
    await db.delete(ephemeral).where(lt(ephemeral.expiresAt, now));
    await db.delete(counters).where(lt(counters.expiresAt, now));
    await collectPendingScores();
  }

  async function scoreJob(jobId: string, criteria: string, opts: { rescore?: boolean }) {
    if (!scorer)
      throw new ScoringUnavailableError(
        "AI scoring needs ANTHROPIC_API_KEY (or let Claude score over MCP)",
      );
    const rows = await db
      .select({ lead: leads, profile: profiles })
      .from(leads)
      .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
      .where(and(eq(leads.jobId, jobId), opts.rescore ? undefined : isNull(leads.aiScore)));
    const items: ScoringInput[] = rows.map(({ lead, profile }) => ({
      id: lead.id,
      username: profile.username,
      fullName: profile.fullName,
      bio: profile.bio,
      followers: profile.followers,
      isBusiness: profile.isBusiness,
      isVerified: profile.isVerified,
      category: profile.category,
      externalUrl: profile.externalUrl,
    }));
    if (items.length === 0) return { mode: "none" as const, count: 0 };
    if (items.length > scorer.batchThreshold) {
      const batchId = await scorer.submitBatch(items, criteria);
      await db
        .update(jobs)
        .set({
          counts: sql`${jobs.counts} || ${JSON.stringify({ aiBatchId: batchId, aiCriteria: criteria })}::jsonb`,
        })
        .where(eq(jobs.id, jobId));
      return { mode: "batch" as const, count: items.length, batchId };
    }
    const scores = await scorer.scoreNow(items, criteria);
    await saveScores(scores);
    await bump(jobId, { scored: scores.size });
    return { mode: "now" as const, count: scores.size };
  }

  const scoreKey = sql`coalesce(${leads.aiScore}, -1)`;
  const followersKey = sql`coalesce(${profiles.followers}, -1)`;
  const encodeCursor = (c: { s: number; f: number; id: string }) =>
    Buffer.from(JSON.stringify(c)).toString("base64url");
  const decodeCursor = (c: string): { s: number; f: number; id: string } | null => {
    try {
      const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
      return typeof v.s === "number" && typeof v.f === "number" && typeof v.id === "string"
        ? v
        : null;
    } catch {
      return null;
    }
  };

  async function leadsPage(
    f: LeadFilters,
  ): Promise<{ leads: LeadRow[]; nextCursor: string | null }> {
    const conds: (SQL | undefined)[] = [eq(leads.projectId, f.projectId)];
    if (f.jobId) conds.push(eq(leads.jobId, f.jobId));
    if (f.business) conds.push(eq(profiles.isBusiness, true));
    if (f.hasEmail) conds.push(isNotNull(leads.email));
    if (f.hasPhone) conds.push(or(isNotNull(leads.phoneE164), isNotNull(leads.phoneRaw)));
    if (f.minScore !== undefined) conds.push(gte(leads.aiScore, f.minScore));
    if (f.status) conds.push(eq(leads.status, f.status));
    if (f.q?.trim()) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      conds.push(
        sql`(${profiles.username} ilike ${like} or ${profiles.fullName} ilike ${like} or ${profiles.bio} ilike ${like})`,
      );
    }
    const cursor = f.cursor ? decodeCursor(f.cursor) : null;
    if (cursor)
      conds.push(
        sql`(${scoreKey}, ${followersKey}, ${leads.id}) < (${cursor.s}, ${cursor.f}, ${cursor.id}::uuid)`,
      );
    const limit = Math.min(f.limit ?? 50, 5000);
    const rows = await db
      .select({
        lead: leads,
        profile: profiles,
        sourceUrl: jobs.sourceUrl,
        others: sql<number>`(select count(*)::int from ${leads} as l2 where l2.profile_id = ${leads.profileId} and l2.project_id <> ${leads.projectId})`,
      })
      .from(leads)
      .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
      .innerJoin(jobs, eq(jobs.id, leads.jobId))
      .where(and(...conds))
      .orderBy(desc(scoreKey), desc(followersKey), desc(leads.id))
      .limit(limit)
      .offset(cursor ? 0 : (f.offset ?? 0));
    const out: LeadRow[] = rows.map(({ lead, profile, sourceUrl, others }) => ({
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
      followUpAt: lead.followUpAt,
      aiScore: lead.aiScore,
      aiTags: lead.aiTags,
      aiReason: lead.aiReason,
      status: lead.status,
      statusNote: lead.statusNote,
      city: profile.city,
      engagementRate: profile.engagementRate === null ? null : Number(profile.engagementRate),
      qualityFlags: profile.qualityFlags,
      otherProjects: Number(others ?? 0),
      sourceUrl,
      fetchedAt: profile.fetchedAt,
    }));
    const last = rows.at(-1);
    const nextCursor =
      rows.length === limit && last
        ? encodeCursor({
            s: last.lead.aiScore ?? -1,
            f: last.profile.followers ?? -1,
            id: last.lead.id,
          })
        : null;
    return { leads: out, nextCursor };
  }

  /**
   * Processes queued work for up to `budgetMs`, for serverless hosts (Vercel)
   * where no long-running worker exists. Reports whether work remains.
   */
  async function drain(opts: { budgetMs: number }) {
    const deadline = Date.now() + opts.budgetMs;
    let processed = 0;
    const queues = [
      { name: QUEUES.discover, run: (d: unknown) => handleDiscover(d as DiscoverPayload) },
      { name: QUEUES.enrich, run: (d: unknown) => handleEnrich(d as EnrichPayload) },
    ];
    let idle = false;
    // Each call takes at least one job even when the budget is already spent
    // (a slow cold start, a busy machine), so a drain always makes progress.
    const overBudget = () => processed > 0 && Date.now() >= deadline;
    while (!overBudget() && !idle) {
      idle = true;
      for (const q of queues) {
        if (overBudget()) break;
        const [job] = await boss.fetch<unknown>(q.name);
        if (!job) continue;
        idle = false;
        try {
          await q.run(job.data);
          await boss.complete(q.name, job.id);
        } catch (err) {
          await boss.fail(q.name, job.id, { message: (err as Error).message });
        }
        processed++;
      }
    }
    await collectPendingScores();
    const [active] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "running"]));
    return { processed, activeJobs: active?.n ?? 0, more: !idle };
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

    listLeads: async (f: LeadFilters): Promise<LeadRow[]> => (await leadsPage(f)).leads,

    /** One page of leads with a cursor for the next page. */
    listLeadsPage: (f: LeadFilters) => leadsPage(f),

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

    drain,
    notify,
    getValue,
    setValue,
    claimOnce,
    hitCounter,

    // ---- browser push subscriptions ----
    async savePushSubscription(sub: { endpoint: string; p256dh: string; auth: string }) {
      await db
        .insert(pushSubscriptions)
        .values(sub)
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { p256dh: sub.p256dh, auth: sub.auth },
        });
    },
    async listPushSubscriptions() {
      return db.select().from(pushSubscriptions);
    },
    async deletePushSubscription(endpoint: string) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    },

    async updateProject(
      projectId: string,
      patch: {
        name?: string | undefined;
        sheetId?: string | null | undefined;
        aiCriteria?: string | null | undefined;
        retentionDays?: number | undefined;
        autoExport?: boolean | undefined;
        watchKeywords?: string[] | null | undefined;
        messageTemplate?: string | null | undefined;
      },
    ) {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (Object.keys(clean).length === 0) return this.getProject(projectId);
      const [p] = await db
        .update(projects)
        .set(clean)
        .where(eq(projects.id, projectId))
        .returning();
      return p ?? null;
    },

    /** Sets (or clears, with null) the date to remind the owner to follow up with a lead. */
    async setFollowUp(input: { projectId: string; username: string; at: Date | null }) {
      const [profile] = await db
        .select({ id: profiles.igUserId })
        .from(profiles)
        .where(eq(profiles.username, input.username.trim().replace(/^@/, "").toLowerCase()));
      if (!profile) return false;
      const updated = await db
        .update(leads)
        .set({ followUpAt: input.at })
        .where(and(eq(leads.projectId, input.projectId), eq(leads.profileId, profile.id)))
        .returning({ id: leads.id });
      return updated.length > 0;
    },

    /**
     * Sends one reminder (bell + Telegram/push) listing the follow-ups that are
     * due, then clears them so each is reminded once. Customers and rejected
     * leads are skipped. Returns how many were due.
     */
    async sendDueFollowUps(now = new Date()) {
      const due = await db
        .select({
          id: leads.id,
          username: profiles.username,
          status: leads.status,
          project: projects.name,
          projectId: projects.id,
        })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .innerJoin(projects, eq(projects.id, leads.projectId))
        .where(
          and(
            isNotNull(leads.followUpAt),
            lte(leads.followUpAt, now),
            notInArray(leads.status, ["customer", "rejected"]),
          ),
        )
        .orderBy(leads.followUpAt)
        .limit(200);
      if (due.length === 0) return 0;
      const lines = due
        .slice(0, 15)
        .map((d) => `@${d.username} · ${d.project} · ${STATUS_AR[d.status] ?? d.status}`);
      if (due.length > 15) lines.push(`و${due.length - 15} غيرهم`);
      await notify({
        type: "system",
        level: "info",
        title: `حان موعد المتابعة مع ${due.length} من العملاء`,
        body: lines.join("\n"),
        url: `/leads/board?project=${due[0]?.projectId}`,
        key: `followup:${now.toISOString().slice(0, 10)}`,
      });
      await db
        .update(leads)
        .set({ followUpAt: null })
        .where(
          inArray(
            leads.id,
            due.map((d) => d.id),
          ),
        );
      return due.length;
    },

    /** Sets where the owner is with a lead (CRM status) and an optional note. */
    async setLeadStatus(input: {
      projectId: string;
      username: string;
      status: LeadStatus;
      note?: string | null;
    }) {
      const [profile] = await db
        .select({ id: profiles.igUserId })
        .from(profiles)
        .where(eq(profiles.username, input.username.trim().replace(/^@/, "").toLowerCase()));
      if (!profile) return false;
      const updated = await db
        .update(leads)
        .set({
          status: input.status,
          statusAt: new Date(),
          ...(input.note !== undefined ? { statusNote: input.note?.slice(0, 500) ?? null } : {}),
        })
        .where(and(eq(leads.projectId, input.projectId), eq(leads.profileId, profile.id)))
        .returning({ id: leads.id });
      return updated.length > 0;
    },

    async leadStatusCounts(projectId: string) {
      const rows = await db
        .select({ status: leads.status, n: sql<number>`count(*)::int` })
        .from(leads)
        .where(eq(leads.projectId, projectId))
        .groupBy(leads.status);
      return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<
        Record<LeadStatus, number>
      >;
    },

    // ---- monitors: recurring "new accounts only" jobs (idea from the Spir bot's schedules) ----
    async createMonitor(input: {
      projectId: string;
      source: Exclude<Source, { type: "upload" }>;
      limit?: number;
      everyDays?: number;
    }) {
      const [m] = await db
        .insert(monitors)
        .values({
          projectId: input.projectId,
          sourceType: input.source.type,
          sourceUrl: input.source.url,
          limit: Math.min(Math.max(1, input.limit ?? 100), maxLimit),
          everyDays: Math.min(Math.max(1, input.everyDays ?? 7), 90),
        })
        .returning();
      if (!m) throw new Error("Monitor insert returned nothing");
      return m;
    },

    async listMonitors(projectId?: string) {
      return db
        .select()
        .from(monitors)
        .where(projectId ? eq(monitors.projectId, projectId) : undefined)
        .orderBy(desc(monitors.createdAt));
    },

    async setMonitorEnabled(id: string, enabled: boolean) {
      await db.update(monitors).set({ enabled }).where(eq(monitors.id, id));
    },

    async deleteMonitor(id: string) {
      await db.delete(monitors).where(eq(monitors.id, id));
    },

    /** Starts a job for every enabled monitor that is due. Returns the job ids. */
    async runDueMonitors(now = new Date()) {
      const due = await db
        .select()
        .from(monitors)
        .where(
          and(
            eq(monitors.enabled, true),
            or(
              isNull(monitors.lastRunAt),
              lte(
                monitors.lastRunAt,
                sql`${now.toISOString()}::timestamptz - make_interval(days => ${monitors.everyDays})`,
              ),
            ),
          ),
        );
      const started: string[] = [];
      for (const m of due) {
        const [job] = await db
          .insert(jobs)
          .values({
            projectId: m.projectId,
            sourceType: m.sourceType,
            sourceUrl: m.sourceUrl,
            limit: m.limit,
            onlyNew: true,
            monitorId: m.id,
          })
          .returning({ id: jobs.id });
        if (!job) continue;
        await boss.send(QUEUES.discover, { jobId: job.id });
        await db.update(monitors).set({ lastRunAt: now }).where(eq(monitors.id, m.id));
        started.push(job.id);
      }
      return started;
    },

    /** Friday summary (idea from the Spir bot's weekly post): sent once per week. */
    async weeklySummary(now = new Date()) {
      const tz = config.timeZone ?? "Asia/Baghdad";
      const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
        now,
      );
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
      if (day !== (config.weeklyDay ?? 5)) return null;
      const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
      if (!(await claimOnce(`weekly:${stamp}`, 8 * 86_400_000))) return null;
      const since = new Date(now.getTime() - 7 * 86_400_000);
      const [t] = await db
        .select({
          leads: sql<number>`count(*)::int`,
          contact: sql<number>`count(*) filter (where ${leads.email} is not null or ${leads.phoneE164} is not null or ${leads.phoneRaw} is not null)::int`,
        })
        .from(leads)
        .where(gte(leads.createdAt, since));
      const [j] = await db
        .select({
          done: sql<number>`count(*) filter (where ${jobs.status} = 'done')::int`,
          failed: sql<number>`count(*) filter (where ${jobs.status} = 'failed')::int`,
        })
        .from(jobs)
        .where(gte(jobs.createdAt, since));
      const top = await db
        .select({ username: profiles.username, score: leads.aiScore })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(and(gte(leads.createdAt, since), isNotNull(leads.aiScore)))
        .orderBy(desc(leads.aiScore))
        .limit(10);
      const body = [
        `عملاء جدد: ${t?.leads ?? 0} (بوسيلة تواصل: ${t?.contact ?? 0})`,
        `مهام اكتملت: ${j?.done ?? 0} · فشلت: ${j?.failed ?? 0}`,
        top.length ? `الأفضل: ${top.map((x) => `@${x.username} (${x.score})`).join("، ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await notify({
        type: "system",
        level: "info",
        title: "ملخص الأسبوع",
        body,
        url: "/",
        key: `weekly:${stamp}`,
      });
      return body;
    },

    /** Database size and row counts for the health card. */
    async systemHealth() {
      const [size] = await db
        .select({ bytes: sql<number>`pg_database_size(current_database())::float8` })
        .from(sql`(select 1) as one`);
      const count = async (t: typeof leads | typeof profiles | typeof jobs) =>
        (await db.select({ n: sql<number>`count(*)::int` }).from(t))[0]?.n ?? 0;
      return {
        dbBytes: Number(size?.bytes ?? 0),
        leads: await count(leads),
        profiles: await count(profiles),
        jobs: await count(jobs),
        lastCron: await getValue<string>("cron:last"),
        providers: router.snapshot(),
        /** Leads created this month that have an AI score (scoring has no own timestamp). */
        scoredThisMonth:
          (
            await db
              .select({ n: sql<number>`count(*)::int` })
              .from(leads)
              .where(
                and(
                  isNotNull(leads.aiScore),
                  gte(leads.createdAt, sql`date_trunc('month', now())`),
                ),
              )
          )[0]?.n ?? 0,
      };
    },

    /** Numbers for the overview page, including leads per day for the last 7 days. */
    async overviewStats() {
      const since = new Date(Date.now() - 7 * 86_400_000);
      const [totals] = await db
        .select({
          leads: sql<number>`count(*)::int`,
          withContact: sql<number>`count(*) filter (where ${leads.email} is not null or ${leads.phoneE164} is not null or ${leads.phoneRaw} is not null)::int`,
          scored: sql<number>`count(*) filter (where ${leads.aiScore} is not null)::int`,
        })
        .from(leads);
      const [jobTotals] = await db
        .select({
          active: sql<number>`count(*) filter (where ${jobs.status} in ('queued', 'running'))::int`,
          today: sql<number>`count(*) filter (where ${jobs.createdAt} >= date_trunc('day', now()))::int`,
          failed7d: sql<number>`count(*) filter (where ${jobs.status} = 'failed' and ${jobs.createdAt} >= ${since.toISOString()}::timestamptz)::int`,
        })
        .from(jobs);
      const days = await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${leads.createdAt}), 'YYYY-MM-DD')`,
          n: sql<number>`count(*)::int`,
        })
        .from(leads)
        .where(gte(leads.createdAt, since))
        .groupBy(sql`1`);
      const byDay = new Map(days.map((d) => [d.day, d.n]));
      const series = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10);
        return { day: d, leads: byDay.get(d) ?? 0 };
      });
      return {
        leads: totals?.leads ?? 0,
        withContact: totals?.withContact ?? 0,
        scored: totals?.scored ?? 0,
        activeJobs: jobTotals?.active ?? 0,
        jobsToday: jobTotals?.today ?? 0,
        failedJobs7d: jobTotals?.failed7d ?? 0,
        series,
      };
    },

    async listNotifications(limit = 30) {
      return db
        .select()
        .from(notifications)
        .orderBy(desc(notifications.at))
        .limit(Math.min(limit, 200));
    },

    async unreadNotifications() {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(isNull(notifications.readAt));
      return row?.n ?? 0;
    },

    async markNotificationsRead() {
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(isNull(notifications.readAt));
    },

    /** Records an action in the activity log. Secrets in the detail are redacted. */
    async audit(entry: {
      actor: string;
      action: string;
      detail?: Record<string, unknown>;
      ip?: string | null;
    }) {
      const detail = entry.detail
        ? (JSON.parse(redactSecrets(JSON.stringify(entry.detail))) as Record<string, unknown>)
        : null;
      await db
        .insert(auditLog)
        .values({ actor: entry.actor, action: entry.action, detail, ip: entry.ip ?? null });
    },

    async listAudit(opts: { limit?: number; action?: string } = {}) {
      return db
        .select()
        .from(auditLog)
        .where(opts.action ? eq(auditLog.action, opts.action) : undefined)
        .orderBy(desc(auditLog.at))
        .limit(Math.min(opts.limit ?? 100, 500));
    },

    /** Failed logins in the last window, for this IP and in total (lockout). */
    async failedLogins(ip: string | null, windowMs = 10 * 60_000) {
      const since = new Date(Date.now() - windowMs);
      const [row] = await db
        .select({
          all: sql<number>`count(*)::int`,
          mine: sql<number>`count(*) filter (where ${auditLog.ip} = ${ip ?? ""})::int`,
        })
        .from(auditLog)
        .where(and(eq(auditLog.action, "login.failed"), gte(auditLog.at, since)));
      return { ip: row?.mine ?? 0, all: row?.all ?? 0 };
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

    /**
     * Scores a job's leads with the AI layer. Small jobs are scored now;
     * large ones are submitted as a batch and collected by drain/retention.
     */
    scoreLeads: (jobId: string, criteria: string, opts: { rescore?: boolean } = {}) =>
      scoreJob(jobId, criteria, opts),

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

    /** Creates an API key; the plain key is returned once and only its hash is stored. */
    async createApiKey(name: string, scopes: ApiScope[] = ["read"]) {
      const key = `sk_${randomBytes(24).toString("base64url")}`;
      const [row] = await db
        .insert(apiKeys)
        .values({ name, keyHash: hashKey(key), scopes })
        .returning();
      if (!row) throw new Error("API key insert returned nothing");
      return { id: row.id, name, scopes, key };
    },

    async listApiKeys() {
      return db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          lastUsed: apiKeys.lastUsed,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .orderBy(desc(apiKeys.createdAt));
    },

    async revokeApiKey(id: string) {
      await db.delete(apiKeys).where(eq(apiKeys.id, id));
    },

    /** Returns the key's scopes, or null when the key is unknown. */
    async verifyApiKey(key: string): Promise<{ id: string; scopes: ApiScope[] } | null> {
      if (!key.startsWith("sk_")) return null;
      const [row] = await db
        .update(apiKeys)
        .set({ lastUsed: new Date() })
        .where(eq(apiKeys.keyHash, hashKey(key)))
        .returning({ id: apiKeys.id, scopes: apiKeys.scopes });
      return row ? { id: row.id, scopes: row.scopes as ApiScope[] } : null;
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
  if (job.sourceType === "followers")
    return { type: "followers", username: parts[0] ?? "", url: job.sourceUrl };
  return { type: "profile", username: parts[0] ?? "", url: job.sourceUrl };
}
