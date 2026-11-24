import { createHash, randomBytes } from "node:crypto";
import {
  type AnyDb,
  accounts,
  apiKeys,
  auditLog,
  brokerEvents,
  competitorSnapshots,
  counters,
  engineEvents,
  engineRuns,
  ephemeral,
  inboxMessages,
  jobs,
  type LeadStatus,
  leadEvents,
  leads,
  monitors,
  notifications,
  ownComments,
  ownPosts,
  partnerClicks,
  partners,
  people,
  profileSnapshots,
  profiles,
  projects,
  pushSubscriptions,
  suppression,
  usageDaily,
  usageSlots,
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
  type AccountRef,
  analyzePosts,
  assignPersona,
  createMxChecker,
  detectLanguage,
  fetchLinkPage,
  growthPercent,
  linkedAccounts,
  parseAccountUrl,
  profileChanges,
  profileQuality,
  type ResolveDeps,
  resolveContact,
  risingSignal,
  searchTextOf,
} from "../extract/index.js";
import { type BudgetLine, planBudget } from "../learn/budget.js";
import {
  auc,
  explainModel,
  type LeadFeatures,
  MIN_LABELLED,
  MIN_POSITIVES,
  predictWin,
  type TrainedModel,
  trainModel,
} from "../learn/model.js";
import { type NotificationInput, type NotificationSink, redactSecrets } from "../notify.js";
import type { AudienceStats, LeadQuery, LeadScore, Scorer, ScoringInput } from "../scoring.js";
import { type SuppressionKind, suppressionHash } from "../suppression.js";
import {
  AccountNotFoundError,
  type Connector,
  type FollowingSource,
  NotFoundError,
  type OwnAccount,
  type PlacesSearch,
  type ProviderId,
  type RawProfile,
  type Source,
} from "../types.js";
import { brokerMethods } from "./features/broker.js";
import type { FeatureContext } from "./features/context.js";
import { engineMethods } from "./features/engine.js";
import { marketMethods } from "./features/market.js";
import { opsMethods } from "./features/ops.js";
import { ownMethods } from "./features/own.js";
import { placesMethods } from "./features/places.js";
import { saverMethods } from "./features/saver.js";
import { usageMethods } from "./features/usage.js";
import { NoProviderError, type ProviderRouter } from "./router.js";

export const QUEUES = {
  discover: "scrapers-discover",
  enrich: "scrapers-enrich",
  retention: "scrapers-retention",
} as const;

export const ENRICH_BATCH = 50;
/** Accounts of a batch processed at the same time (after their profiles are read). */
export const ENRICH_CONCURRENCY = 8;

export interface ScrapersConfig {
  suppressionPepper: string;
  maxJobLimit?: number;
  defaultRetentionDays?: number;
  /** Reuse a profile fetched within this many days instead of fetching it again (0 disables). */
  profileCacheDays?: number;
  /**
   * Followers and hashtag lists above this many accounts are collected by a
   * background run (Apify) instead of one long request (default 300).
   */
  backgroundAbove?: number;
  /** Where the provider reports a finished background run (null: found by polling). */
  discoveryNotifyUrl?: string | null;
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
  /** ISO 3166-1 alpha-2. */
  country?: string;
  /** ISO 639-1 (ar, en, ...). */
  language?: string;
  /** Found in at least this many sources (competitors, posts). */
  minSources?: number;
  minFollowers?: number;
  maxFollowers?: number;
  /** Audience segment (see buildPersonas). */
  persona?: string;
  /** A timing signal such as rising or became_business. */
  signal?: string;
  /** Words or phrases with the same meaning; a lead matches any of them. */
  terms?: string[];
  /** Has an account on this other platform (youtube, telegram, tiktok, website...). */
  platform?: string;
  /** Model's chance of becoming a customer at least this high (0-100). */
  minWinProb?: number;
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
  /** Sources the account was found in, and how many. */
  sources?: string[] | null;
  sourceCount?: number;
  country?: string | null;
  language?: string | null;
  /** Value of the closed deal, when recorded. */
  dealValue?: number | null;
  /** Chance (0-100) it becomes a customer, by the project's own model. */
  winProb?: number | null;
  persona?: string | null;
  signals?: string[] | null;
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
  /** Readers for other platforms (YouTube, Telegram...), one per platform. */
  connectors?: Connector[];
  /** Google Maps search (Apify). */
  places?: PlacesSearch;
  /** The owner's own Instagram account (Graph API), for comments and messages. */
  own?: OwnAccount;
  /** Who an account follows (Apify), for finding new sources from the best customers. */
  following?: FollowingSource;
  /** Reads one public web page (for watching competitor sites). */
  readPage?: (url: string) => Promise<{ title: string | null; text: string }>;
}) {
  const { db, boss, router, config, scorer } = deps;
  const sinks = deps.sinks ?? [];
  const resolveDeps: ResolveDeps = deps.resolve ?? {
    linkPage: (url) => fetchLinkPage(url),
    checkEmail: createMxChecker(),
  };
  const cacheDays = config.profileCacheDays ?? 30;
  const connectors = new Map((deps.connectors ?? []).map((c) => [c.platform, c]));
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

  /** Adds what a step cost (estimated from the provider's price per result) to the job. */
  async function addCost(jobId: string, usd: number) {
    if (!(usd > 0)) return;
    await db
      .update(jobs)
      .set({ costUsd: sql`${jobs.costUsd} + ${usd.toFixed(4)}::numeric` })
      .where(eq(jobs.id, jobId));
  }

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
  ): Promise<string[]> {
    const [before] = await db.select().from(profiles).where(eq(profiles.igUserId, p.igUserId));
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
      language: detectLanguage(`${p.fullName ?? ""} ${p.bio ?? ""}`),
      searchText: searchTextOf(p),
      fetchedAt: new Date(),
      fetchedBy,
    };
    // Every fetch is kept as a snapshot, so growth over time can be read.
    await db.insert(profileSnapshots).values({
      profileId: p.igUserId,
      followers: values.followers,
      following: values.following,
      posts: values.posts,
      isBusiness: values.isBusiness,
    });
    const history = await db
      .select({ at: profileSnapshots.at, followers: profileSnapshots.followers })
      .from(profileSnapshots)
      .where(
        and(
          eq(profileSnapshots.profileId, p.igUserId),
          gte(profileSnapshots.at, new Date(Date.now() - 120 * 86_400_000)),
        ),
      )
      .orderBy(profileSnapshots.at);
    const rise = risingSignal(history);
    const signals = [
      ...(rise.rising ? ["rising"] : []),
      ...(before && !before.isBusiness && p.isBusiness ? ["became_business"] : []),
    ];
    // Every Instagram account belongs to a person; their other platforms hang off the person.
    let personId = before?.personId ?? null;
    if (!personId) {
      const [person] = await db.insert(people).values({}).returning({ id: people.id });
      personId = person?.id ?? null;
    }
    const row = { ...values, personId, signals: signals.length ? signals : null };
    await db
      .insert(profiles)
      .values(row)
      .onConflictDoUpdate({ target: profiles.igUserId, set: row });
    if (personId) await linkAccounts(personId, linkedAccounts(p.bio, p.externalUrl), "bio_link");
    const changes = before ? profileChanges(before, values) : [];
    if (rise.rising && !before?.signals?.includes("rising"))
      changes.push(`ينمو بسرعة (+${rise.percent}% خلال ${rise.days} يوماً)`);
    return changes;
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
        if (job.limit > (config.backgroundAbove ?? 300)) {
          // A large list: a background run that reports back when it is done.
          const started = await router.startEngagers(
            source,
            job.limit,
            config.discoveryNotifyUrl ?? null,
          );
          if (started) {
            await db.update(jobs).set({ provider: started.provider }).where(eq(jobs.id, job.id));
            await setValue(
              `discover-run:${job.id}`,
              { runId: started.runId, provider: started.provider, startedAt: Date.now() },
              3 * 86_400_000,
            );
            return;
          }
        }
        const found = await router.listEngagers(source, job.limit);
        usernames = found.usernames;
        await db.update(jobs).set({ provider: found.provider }).where(eq(jobs.id, job.id));
        await addCost(job.id, router.unitCost(found.provider) * usernames.length);
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
    await continueDiscovery(job, usernames);
  }

  /** Discovered usernames (from a request or a background run) go on to be read. */
  async function continueDiscovery(job: typeof jobs.$inferSelect, found: string[]) {
    let usernames = found;
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

    // Read by the Spir engine (free, slower): accounts already in the cache are
    // read here at no cost, the rest go to an engine run for this project.
    let viaEngine = 0;
    if (usernames.length > 0 && (await getValue<string>(`job-read:${job.id}`)) === "engine") {
      const fresh =
        cacheDays > 0
          ? await db
              .select({ username: profiles.username })
              .from(profiles)
              .where(
                and(
                  inArray(profiles.username, usernames),
                  gte(profiles.fetchedAt, new Date(Date.now() - cacheDays * 86_400_000)),
                ),
              )
          : [];
      const cached = new Set(fresh.map((f) => f.username));
      const toEngine = usernames.filter((u) => !cached.has(u));
      if (toEngine.length > 0) {
        const label = await jobLabel(job.id);
        await api.createEngineRun({
          name: `مهمة: ${label?.project ?? ""} ${job.sourceUrl}`.slice(0, 80),
          projectId: job.projectId,
          seeds: toEngine,
          maxDepth: 0,
          maxAccounts: toEngine.length,
        });
        viaEngine = toEngine.length;
        usernames = usernames.filter((u) => cached.has(u));
      }
    }

    await db
      .update(jobs)
      .set({
        counts: { discovered: usernames.length, ...(viaEngine ? { viaEngine } : {}) },
      })
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
    let costUsd = 0;
    const watchHits: string[] = [];
    const changed: string[] = [];
    let deferred: string[] = [];

    // Accounts not cached are read in one batch where a provider can (one Apify run).
    const prefetched = await router.getProfiles(
      names.filter((u) => !cached.has(u) && !blocked.has(suppressionHash("username", u, pepper))),
    );

    // Reading accounts one by one stays in turn, so a provider that starts
    // refusing is rested after one refusal, not hit by several at once.
    let fetchTurn: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = fetchTurn.then(fn);
      fetchTurn = run.catch(() => {});
      return run;
    };

    const enrichOne = async (username: string): Promise<"done" | "defer"> => {
      if (blocked.has(suppressionHash("username", username, pepper))) {
        delta.skipped++;
        return "done";
      }

      let profile: RawProfile;
      let provider: "graph" | "apify" | "worker";
      let quality: { engagementRate: number | null; flags: string[] };
      const hit = cached.get(username);
      const pre = prefetched.profiles.get(username);
      if (hit) {
        profile = rowToRaw(hit);
        provider = hit.fetchedBy === "upload" ? "worker" : hit.fetchedBy;
        quality = {
          engagementRate: hit.engagementRate === null ? null : Number(hit.engagementRate),
          flags: hit.qualityFlags ?? [],
        };
        delta.cached++;
      } else if (pre) {
        profile = pre.profile;
        provider = pre.provider;
        costUsd += router.unitCost(provider);
        quality = profileQuality(profile);
      } else if (prefetched.missing.has(username)) {
        // The batch read came back without it: private or gone.
        delta.skipped++;
        return "done";
      } else {
        try {
          const fetched = await inTurn(() => router.getProfile(username));
          profile = fetched.profile;
          provider = fetched.provider;
          costUsd += router.unitCost(provider);
          quality = profileQuality(profile);
        } catch (err) {
          if (err instanceof NotFoundError) {
            delta.skipped++;
            return "done";
          }
          if (err instanceof NoProviderError && router.exhausted("profile")) {
            // Every provider is resting: resume this account and the rest later instead of failing them.
            return "defer";
          }
          delta.failed++;
          return "done";
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
        return "done";
      }
      const changes = hit ? [] : await saveProfile(profile, provider, quality);
      const phone = contact.phoneE164 ?? contact.phoneRaw;
      if (project.skipFake && quality.flags.length >= 2 && !contact.email && !phone) {
        delta.skipped++;
        return "done";
      }
      const projectModel = (project.model as TrainedModel | null) ?? null;
      const leadValues = {
        ...(projectModel
          ? {
              winProb: predictWin(projectModel, {
                followers: profile.followers ?? null,
                engagementRate: quality.engagementRate,
                sourceCount: 1,
                isBusiness: profile.isBusiness,
                hasEmail: !!contact.email,
                hasPhone: !!phone,
                aiScore: null,
                arabic: detectLanguage(`${profile.fullName ?? ""} ${profile.bio ?? ""}`) === "ar",
                rising: false,
                qualityFlags: quality.flags.length,
              }),
            }
          : {}),
        ...(project.personas?.length
          ? { persona: assignPersona(searchTextOf(profile), project.personas) }
          : {}),
        jobId: job.id,
        email: contact.email,
        phoneE164: contact.phoneE164,
        phoneRaw: contact.phoneRaw,
        phoneCountry: contact.phoneCountry,
        contactSource: contact.contactSource,
        phoneHash: phone ? suppressionHash("phone", phone, pepper) : null,
        country: contact.phoneCountry ?? contact.countries[0] ?? null,
        expiresAt,
      };
      // Every source the account turns up in is kept: several competitors means more interest.
      const merged = sql`case when ${job.sourceUrl} = any(coalesce(${leads.sources}, '{}'::text[])) then ${leads.sources} else array_append(coalesce(${leads.sources}, '{}'::text[]), ${job.sourceUrl}) end`;
      // On conflict the lead's status and note are kept: only the data is refreshed.
      const [saved] = await db
        .insert(leads)
        .values({
          projectId: job.projectId,
          profileId: profile.igUserId,
          ...leadValues,
          sources: [job.sourceUrl],
          sourceCount: 1,
        })
        .onConflictDoUpdate({
          target: [leads.projectId, leads.profileId],
          set: {
            ...leadValues,
            country: sql`coalesce(${leadValues.country}, ${leads.country})`,
            sources: merged,
            sourceCount: sql`cardinality(${merged})`,
          },
        })
        .returning({ id: leads.id, createdAt: leads.createdAt });
      if (saved && changes.length > 0 && saved.createdAt.getTime() < Date.now() - 60_000) {
        // A lead the project already had changed since the last fetch.
        await db
          .insert(leadEvents)
          .values({ leadId: saved.id, kind: "change", text: changes.join("، ") });
        changed.push(`@${profile.username}: ${changes.join("، ")}`);
      }
      delta.enriched++;
      if (contact.email || phone) delta.leads++;
      if (matchKeywords(profile, project.watchKeywords).length) watchHits.push(profile.username);
      return "done";
    };

    // A few accounts at a time: link pages, MX checks and saves overlap instead of waiting in turn.
    const queue = [...names];
    let processed = 0;
    while (queue.length > 0) {
      if (processed > 0) {
        // Re-checked between rounds so cancelling takes effect quickly.
        const [current] = await db
          .select({ status: jobs.status })
          .from(jobs)
          .where(eq(jobs.id, job.id));
        if (current?.status !== "running") break;
      }
      const round = queue.splice(0, ENRICH_CONCURRENCY);
      const results = await Promise.all(round.map((u) => enrichOne(u)));
      processed += round.length;
      const later = round.filter((_, k) => results[k] === "defer");
      if (later.length > 0) {
        deferred = [...later, ...queue];
        break;
      }
    }

    await bump(job.id, delta);
    await addCost(job.id, costUsd);
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
    if (changed.length > 0) {
      await notify({
        type: "system",
        level: "info",
        title: `تغيّرت حسابات ${changed.length} من عملائك في ${project.name}`,
        body: changed.slice(0, 15).join("\n"),
        url: `/leads?project=${project.id}`,
        key: `changes:${job.id}:${changed.length}`,
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
          ...(sc.country && /^[A-Za-z]{2}$/.test(sc.country)
            ? { country: sql`coalesce(${leads.country}, ${sc.country.toUpperCase()})` }
            : {}),
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
    // Free database plans are small: keep what is still useful, drop the rest.
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    await db.delete(profileSnapshots).where(lt(profileSnapshots.at, daysAgo(180)));
    await db.delete(competitorSnapshots).where(lt(competitorSnapshots.at, daysAgo(365)));
    await db.delete(notifications).where(lt(notifications.at, daysAgo(60)));
    await db.delete(auditLog).where(lt(auditLog.at, daysAgo(180)));
    await db.delete(partnerClicks).where(lt(partnerClicks.at, daysAgo(365)));
    await db.delete(engineEvents).where(lt(engineEvents.at, daysAgo(30)));
    // Usage: slots for two months (the page shows this month), daily counts for a year.
    await db.delete(usageSlots).where(lt(usageSlots.day, daysAgo(62).toISOString().slice(0, 10)));
    await db.delete(usageDaily).where(lt(usageDaily.day, daysAgo(400).toISOString().slice(0, 10)));
    // Finished engine runs (and their queues) after 90 days; their leads stay in the projects.
    await db
      .delete(engineRuns)
      .where(and(isNotNull(engineRuns.finishedAt), lt(engineRuns.finishedAt, daysAgo(90))));
    await collectPendingScores();
  }

  /**
   * Attaches accounts to a person. An account already attached to someone
   * else stays where it is (two people never share an account).
   */
  async function linkAccounts(
    personId: string,
    refs: AccountRef[],
    source: "bio_link" | "manual" | "website",
  ) {
    const own = refs.filter((r) => !(r.platform === "instagram"));
    if (own.length === 0) return [];
    return db
      .insert(accounts)
      .values(
        own.map((r) => ({ personId, platform: r.platform, handle: r.handle, url: r.url, source })),
      )
      .onConflictDoNothing({ target: [accounts.platform, accounts.handle] })
      .returning({ id: accounts.id, platform: accounts.platform });
  }

  /** Reads an account through its platform's connector and stores what it found. */
  async function refreshAccount(id: string) {
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, id));
    if (!acc) return null;
    const connector = connectors.get(acc.platform);
    if (!connector) return acc;
    try {
      const r = await connector.getAccount(acc.handle);
      // Accounts the person links from there (e.g. their website's social icons) are theirs too.
      if (r.links?.length)
        await linkAccounts(
          acc.personId,
          r.links.map((l) => parseAccountUrl(l)).filter((x): x is AccountRef => !!x),
          "website",
        );
      const [updated] = await db
        .update(accounts)
        .set({
          displayName: r.displayName,
          bio: r.bio?.slice(0, 2000) ?? null,
          followers: r.followers,
          stats: r.stats ?? null,
          fetchedAt: new Date(),
          error: null,
        })
        .where(eq(accounts.id, id))
        .returning();
      return updated ?? acc;
    } catch (err) {
      const message =
        err instanceof AccountNotFoundError
          ? "غير موجود أو خاص"
          : (err as Error).message.slice(0, 300);
      const [updated] = await db
        .update(accounts)
        .set({ error: message, fetchedAt: new Date() })
        .where(eq(accounts.id, id))
        .returning();
      return updated ?? acc;
    }
  }

  /** What the model reads for every lead of a project, with its outcome when known. */
  async function projectFeatures(projectId: string) {
    const rows = await db
      .select({
        id: leads.id,
        status: leads.status,
        aiScore: leads.aiScore,
        sourceCount: leads.sourceCount,
        email: leads.email,
        phone: sql<string | null>`coalesce(${leads.phoneE164}, ${leads.phoneRaw})`,
        followers: profiles.followers,
        engagementRate: profiles.engagementRate,
        isBusiness: profiles.isBusiness,
        language: profiles.language,
        signals: profiles.signals,
        qualityFlags: profiles.qualityFlags,
      })
      .from(leads)
      .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
      .where(eq(leads.projectId, projectId))
      .limit(50_000);
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      aiScore: r.aiScore,
      features: {
        followers: r.followers,
        engagementRate: r.engagementRate === null ? null : Number(r.engagementRate),
        sourceCount: r.sourceCount,
        isBusiness: r.isBusiness,
        hasEmail: !!r.email,
        hasPhone: !!r.phone,
        aiScore: r.aiScore,
        arabic: r.language === "ar",
        rising: !!r.signals?.includes("rising"),
        qualityFlags: r.qualityFlags?.length ?? 0,
      } satisfies LeadFeatures,
    }));
  }

  /** Customers and interested leads are wins; rejected ones are losses; the rest are unknown. */
  const outcomeOf = (status: string): 0 | 1 | null =>
    status === "customer" || status === "interested" ? 1 : status === "rejected" ? 0 : null;

  /**
   * A lead's deal value from the broker's events: commissions when the broker
   * reports them, otherwise deposits. Status becomes customer on a deposit.
   */
  async function refreshDealFromBroker(leadId: string) {
    const [agg] = await db
      .select({
        commission: sql<string>`coalesce(sum(${brokerEvents.amount}) filter (where ${brokerEvents.event} = 'commission'), 0)`,
        deposits: sql<string>`coalesce(sum(${brokerEvents.amount}) filter (where ${brokerEvents.event} in ('ftd', 'deposit')), 0)`,
        funded: sql<number>`count(*) filter (where ${brokerEvents.event} in ('ftd', 'deposit', 'commission'))::int`,
        first: sql<Date | null>`min(${brokerEvents.at}) filter (where ${brokerEvents.event} in ('ftd', 'deposit', 'commission'))`,
      })
      .from(brokerEvents)
      .where(eq(brokerEvents.leadId, leadId));
    if (!agg || Number(agg.funded) === 0) return;
    const commission = Number(agg.commission);
    const value = commission > 0 ? commission : Number(agg.deposits);
    await db
      .update(leads)
      .set({
        status: "customer",
        statusAt: sql`coalesce(${leads.statusAt}, now())`,
        dealValue: value.toFixed(2),
        dealAt: sql`coalesce(${leads.dealAt}, ${agg.first ? new Date(agg.first).toISOString() : new Date().toISOString()}::timestamptz)`,
        followUpAt: null,
      })
      .where(eq(leads.id, leadId));
  }

  /** Puts every lead of the project in the persona whose words it uses most. */
  async function assignPersonas(
    projectId: string,
    personas: { name: string; keywords: string[] }[],
  ): Promise<number> {
    const rows = await db
      .select({
        id: leads.id,
        text: profiles.searchText,
        username: profiles.username,
        bio: profiles.bio,
      })
      .from(leads)
      .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
      .where(eq(leads.projectId, projectId))
      .limit(50_000);
    const groups = new Map<string | null, string[]>();
    for (const r of rows) {
      const name = assignPersona(
        r.text ?? searchTextOf({ username: r.username, bio: r.bio }),
        personas,
      );
      const ids = groups.get(name) ?? [];
      ids.push(r.id);
      groups.set(name, ids);
    }
    let assigned = 0;
    for (const [name, ids] of groups) {
      for (let i = 0; i < ids.length; i += 1000) {
        await db
          .update(leads)
          .set({ persona: name })
          .where(inArray(leads.id, ids.slice(i, i + 1000)));
      }
      if (name) assigned += ids.length;
    }
    return assigned;
  }

  /**
   * Adds the owner's own decisions to the criteria (accounts they marked as
   * customers or interested, and ones they rejected), so scoring follows them.
   */
  async function withExamples(projectId: string, criteria: string): Promise<string> {
    const pick = (statuses: LeadStatus[]) =>
      db
        .select({ username: profiles.username, bio: profiles.bio, category: profiles.category })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(and(eq(leads.projectId, projectId), inArray(leads.status, statuses)))
        .orderBy(desc(leads.statusAt))
        .limit(6);
    const [good, bad] = await Promise.all([pick(["customer", "interested"]), pick(["rejected"])]);
    if (good.length + bad.length < 3) return criteria;
    const line = (r: { username: string; bio: string | null; category: string | null }) =>
      `- @${r.username}${r.category ? ` (${r.category})` : ""}: ${(r.bio ?? "").replace(/\s+/g, " ").slice(0, 140)}`;
    return [
      criteria,
      good.length
        ? `\nAccounts the operator accepted (score similar ones higher):\n${good.map(line).join("\n")}`
        : "",
      bad.length
        ? `\nAccounts the operator rejected (score similar ones lower):\n${bad.map(line).join("\n")}`
        : "",
    ].join("\n");
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
      sources: lead.sourceCount,
    }));
    if (items.length === 0) return { mode: "none" as const, count: 0 };
    const [first] = rows;
    if (first) criteria = await withExamples(first.lead.projectId, criteria);
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
    if (f.country) conds.push(eq(leads.country, f.country.toUpperCase()));
    if (f.language) conds.push(eq(profiles.language, f.language.toLowerCase()));
    if (f.minSources) conds.push(gte(leads.sourceCount, f.minSources));
    if (f.minFollowers !== undefined) conds.push(gte(profiles.followers, f.minFollowers));
    if (f.maxFollowers !== undefined) conds.push(lte(profiles.followers, f.maxFollowers));
    if (f.persona) conds.push(eq(leads.persona, f.persona));
    if (f.minWinProb !== undefined) conds.push(gte(leads.winProb, f.minWinProb));
    if (f.platform)
      conds.push(
        sql`exists (select 1 from ${accounts} a where a.person_id = ${profiles.personId} and a.platform = ${f.platform})`,
      );
    if (f.signal) conds.push(sql`${profiles.signals} @> array[${f.signal}]::text[]`);
    const terms = (f.terms ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1);
    if (terms.length)
      conds.push(
        or(
          ...terms
            .slice(0, 20)
            .map(
              (t) =>
                sql`(${profiles.searchText} ilike ${`%${t.replace(/[%_\\]/g, (m) => `\\${m}`)}%`} or word_similarity(${t}, ${profiles.searchText}) > 0.6)`,
            ),
        ),
      );
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
      sources: lead.sources,
      sourceCount: lead.sourceCount,
      dealValue: lead.dealValue === null ? null : Number(lead.dealValue),
      winProb: lead.winProb,
      persona: lead.persona,
      signals: profile.signals,
      country: lead.country,
      language: profile.language,
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

  /** Fails a job whose list could not be collected, and tells the owner. */
  async function failDiscovery(job: typeof jobs.$inferSelect, message: string) {
    await db
      .update(jobs)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
    const label = await jobLabel(job.id);
    await notify({
      type: "job",
      level: "bad",
      title: `فشلت مهمة ${label?.project ?? ""}`.trim(),
      body: `${job.sourceUrl}\n${message}`,
      url: `/jobs/${job.id}`,
      key: `job-failed:${job.id}`,
    });
  }

  /**
   * Checks background runs: those that ended are read and their accounts
   * queued for reading (each run once, even if the webhook and a poll race).
   * `runId` limits the check to one run (the provider's webhook).
   */
  async function collectDiscoveryRuns(runId?: string) {
    const pending = await db
      .select({ key: ephemeral.key, value: ephemeral.value })
      .from(ephemeral)
      .where(and(sql`${ephemeral.key} like 'discover-run:%'`, sql`${ephemeral.expiresAt} > now()`));
    let finished = 0;
    for (const row of pending) {
      const v = row.value as { runId: string; provider: ProviderId; startedAt: number };
      if (runId && v.runId !== runId) continue;
      const jobId = row.key.slice("discover-run:".length);
      const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      if (job?.status !== "running") {
        await db.delete(ephemeral).where(eq(ephemeral.key, row.key));
        continue;
      }
      let state: Awaited<ReturnType<ProviderRouter["collectEngagers"]>>;
      try {
        state = await router.collectEngagers(v.provider, v.runId, sourceFromJob(job), job.limit);
      } catch (err) {
        state = { status: "failed", error: (err as Error).message };
      }
      if (state.status === "running") continue;
      if (!(await claimOnce(`discover-done:${v.runId}`, 3 * 86_400_000))) continue;
      await db.delete(ephemeral).where(eq(ephemeral.key, row.key));
      finished++;
      if (state.status === "failed") {
        await failDiscovery(job, state.error);
        continue;
      }
      await addCost(job.id, router.unitCost(v.provider) * state.usernames.length);
      await continueDiscovery(job, state.usernames);
    }
    return finished;
  }

  /**
   * Processes queued work for up to `budgetMs`, for serverless hosts (Vercel)
   * where no long-running worker exists. Reports whether work remains.
   */
  async function drain(opts: { budgetMs: number }) {
    const deadline = Date.now() + opts.budgetMs;
    // Background runs that ended (in case the provider's webhook did not arrive).
    let processed = await collectDiscoveryRuns().catch(() => 0);
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

  // Feature modules get the shared helpers and call other service methods through self().
  const featureCtx: FeatureContext = {
    db,
    deps,
    scorer,
    pepper,
    notify,
    getValue,
    setValue,
    refreshDealFromBroker,
    saveProfile,
    timeZone: config.timeZone ?? "Asia/Baghdad",
    connectors,
    maxJobLimit: maxLimit,
    self: () => api,
  };

  const api = {
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
          : input.readVia === "auto" && (await api.engineOnline())
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
    collectDiscoveryRuns,
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
        skipFake?: boolean | undefined;
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
      if (updated[0])
        await db.insert(leadEvents).values({
          leadId: updated[0].id,
          kind: "follow_up",
          text: input.at
            ? `تذكير متابعة يوم ${input.at.toISOString().slice(0, 10)}`
            : "أُلغي تذكير المتابعة",
        });
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
      if (updated[0])
        await db.insert(leadEvents).values({
          leadId: updated[0].id,
          kind: "status",
          text: `الحالة: ${STATUS_AR[input.status] ?? input.status}${input.note ? ` · ${input.note.slice(0, 200)}` : ""}`,
        });
      return updated.length > 0;
    },

    /**
     * Records a closed deal: the lead becomes a customer and its value is
     * credited to every source it was found in (see sourcePerformance).
     * A null value clears the deal.
     */
    async setDeal(input: { projectId: string; username: string; value: number | null; at?: Date }) {
      const u = input.username.trim().replace(/^@/, "").toLowerCase();
      const [profile] = await db
        .select({ id: profiles.igUserId })
        .from(profiles)
        .where(eq(profiles.username, u));
      if (!profile) return false;
      const value = input.value === null ? null : Math.max(0, Math.round(input.value * 100) / 100);
      const at = input.at ?? new Date();
      const updated = await db
        .update(leads)
        .set(
          value === null
            ? { dealValue: null, dealAt: null }
            : {
                dealValue: value.toFixed(2),
                dealAt: at,
                status: "customer",
                statusAt: sql`coalesce(${leads.statusAt}, ${at.toISOString()}::timestamptz)`,
                followUpAt: null,
              },
        )
        .where(and(eq(leads.projectId, input.projectId), eq(leads.profileId, profile.id)))
        .returning({ id: leads.id });
      if (updated[0])
        await db.insert(leadEvents).values({
          leadId: updated[0].id,
          kind: "status",
          text: value === null ? "أُلغيت الصفقة" : `صفقة بقيمة ${value.toLocaleString("en")}$`,
        });
      return updated.length > 0;
    },

    /**
     * What each source (competitor followers, post, hashtag, upload) brought:
     * accounts, contacts, how far they got, deals and their value, cost, and
     * return. A lead found in several sources counts in each; its deal value
     * is split evenly between them so totals add up.
     */
    async sourcePerformance(projectId: string, opts: { since?: Date } = {}) {
      const since = opts.since
        ? sql`and l.created_at >= ${opts.since.toISOString()}::timestamptz`
        : sql``;
      const res = await db.execute<{
        source: string;
        leads: number;
        contact: number;
        reached: number;
        interested: number;
        customers: number;
        revenue: string | null;
        days_to_close: string | null;
      }>(sql`
        select src as source,
               count(*)::int as leads,
               count(*) filter (where l.email is not null or l.phone_e164 is not null or l.phone_raw is not null)::int as contact,
               count(*) filter (where l.status <> 'new')::int as reached,
               count(*) filter (where l.status in ('interested', 'customer'))::int as interested,
               count(*) filter (where l.status = 'customer')::int as customers,
               sum(l.deal_value / greatest(l.source_count, 1)) as revenue,
               avg(extract(epoch from (l.deal_at - l.created_at)) / 86400) filter (where l.deal_at is not null) as days_to_close
        from ${leads} l
        cross join lateral unnest(coalesce(l.sources, '{}'::text[])) as src
        where l.project_id = ${projectId}::uuid ${since}
        group by src`);
      const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as {
        source: string;
        leads: number;
        contact: number;
        reached: number;
        interested: number;
        customers: number;
        revenue: string | null;
        days_to_close: string | null;
      }[];
      const costs = await db
        .select({
          source: jobs.sourceUrl,
          cost: sql<string>`sum(${jobs.costUsd})`,
          runs: sql<number>`count(*)::int`,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.projectId, projectId),
            opts.since ? gte(jobs.createdAt, opts.since) : undefined,
          ),
        )
        .groupBy(jobs.sourceUrl);
      const costBy = new Map(
        costs.map((c) => [c.source, { cost: Number(c.cost ?? 0), runs: c.runs }]),
      );
      const out = rows.map((r) => {
        const revenue = Math.round(Number(r.revenue ?? 0) * 100) / 100;
        const cost = Math.round((costBy.get(r.source)?.cost ?? 0) * 10000) / 10000;
        return {
          source: r.source,
          runs: costBy.get(r.source)?.runs ?? 0,
          leads: Number(r.leads),
          contact: Number(r.contact),
          reached: Number(r.reached),
          interested: Number(r.interested),
          customers: Number(r.customers),
          revenue,
          costUsd: cost,
          /** Revenue per dollar spent; null when nothing was spent. */
          roi: cost > 0 ? Math.round((revenue / cost) * 10) / 10 : null,
          /** Share of reached accounts that became customers, in percent. */
          closeRate:
            Number(r.reached) > 0
              ? Math.round((Number(r.customers) / Number(r.reached)) * 1000) / 10
              : null,
          costPerCustomer:
            Number(r.customers) > 0 ? Math.round((cost / Number(r.customers)) * 100) / 100 : null,
          daysToClose:
            r.days_to_close === null ? null : Math.round(Number(r.days_to_close) * 10) / 10,
        };
      });
      out.sort((a, b) => b.revenue - a.revenue || b.customers - a.customers || b.leads - a.leads);
      const total = out.reduce(
        (t, r) => ({ revenue: t.revenue + r.revenue, costUsd: t.costUsd + r.costUsd }),
        { revenue: 0, costUsd: 0 },
      );
      const [deals] = await db
        .select({
          customers: sql<number>`count(*) filter (where ${leads.status} = 'customer')::int`,
          withValue: sql<number>`count(*) filter (where ${leads.dealValue} is not null)::int`,
        })
        .from(leads)
        .where(eq(leads.projectId, projectId));
      return {
        sources: out,
        totals: {
          revenue: Math.round(total.revenue * 100) / 100,
          costUsd: Math.round(total.costUsd * 10000) / 10000,
          customers: deals?.customers ?? 0,
          /** Customers whose deal value is recorded; the report is only as good as this. */
          customersWithValue: deals?.withValue ?? 0,
        },
      };
    },

    /**
     * Accounts in the project that read most like this one (name, category and
     * bio, by trigram similarity): "find more like my best customer".
     */
    async similarLeads(projectId: string, username: string, limit = 10) {
      const u = username.replace(/^@/, "").toLowerCase();
      const [seed] = await db
        .select({ id: profiles.igUserId, text: profiles.searchText, bio: profiles.bio })
        .from(profiles)
        .where(eq(profiles.username, u));
      if (!seed) return [];
      const text = seed.text ?? searchTextOf({ username: u, bio: seed.bio });
      const score = sql<number>`similarity(${profiles.searchText}, ${text})`;
      const rows = await db
        .select({
          username: profiles.username,
          fullName: profiles.fullName,
          followers: profiles.followers,
          status: leads.status,
          aiScore: leads.aiScore,
          persona: leads.persona,
          similarity: score,
        })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(
          and(
            eq(leads.projectId, projectId),
            ne(leads.profileId, seed.id),
            // Measured: same-topic bios score 0.2-0.3, unrelated ones about 0.1.
            sql`${score} > 0.15`,
          ),
        )
        .orderBy(desc(score))
        .limit(Math.min(limit, 50));
      return rows.map((r) => ({ ...r, similarity: Math.round(Number(r.similarity) * 100) / 100 }));
    },

    /**
     * Finds the project's audience segments with AI (from a sample of bios),
     * saves them, and assigns every lead to the segment whose words it uses.
     */
    async buildPersonas(projectId: string) {
      if (!scorer?.personas)
        throw new ScoringUnavailableError("Audience segments need ANTHROPIC_API_KEY");
      const project = await this.getProject(projectId);
      if (!project) throw new Error("Project not found");
      const sample = await db
        .select({ username: profiles.username, bio: profiles.bio, category: profiles.category })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(and(eq(leads.projectId, projectId), isNotNull(profiles.bio)))
        .orderBy(sql`random()`)
        .limit(150);
      if (sample.length < 5) throw new Error("نحتاج 5 حسابات على الأقل لها بايو");
      const personas = (await scorer.personas(sample, project.aiCriteria ?? "")).slice(0, 8);
      await db.update(projects).set({ personas }).where(eq(projects.id, projectId));
      const assigned = await assignPersonas(projectId, personas);
      return { personas, assigned };
    },

    /** Leads, customers and revenue per audience segment. */
    async personaPerformance(projectId: string) {
      const rows = await db
        .select({
          persona: leads.persona,
          leads: sql<number>`count(*)::int`,
          reached: sql<number>`count(*) filter (where ${leads.status} <> 'new')::int`,
          customers: sql<number>`count(*) filter (where ${leads.status} = 'customer')::int`,
          revenue: sql<string>`coalesce(sum(${leads.dealValue}), 0)`,
        })
        .from(leads)
        .where(and(eq(leads.projectId, projectId), isNotNull(leads.persona)))
        .groupBy(leads.persona);
      return rows
        .map((r) => ({
          persona: r.persona as string,
          leads: Number(r.leads),
          reached: Number(r.reached),
          customers: Number(r.customers),
          revenue: Number(r.revenue),
          closeRate:
            Number(r.reached) > 0
              ? Math.round((Number(r.customers) / Number(r.reached)) * 1000) / 10
              : null,
        }))
        .sort((a, b) => b.revenue - a.revenue || b.customers - a.customers || b.leads - a.leads);
    },

    ...placesMethods(featureCtx),

    /** A lead's person's accounts on other platforms. */
    async personAccounts(username: string) {
      const [p] = await db
        .select({ personId: profiles.personId })
        .from(profiles)
        .where(eq(profiles.username, username.replace(/^@/, "").toLowerCase()));
      if (!p?.personId) return [];
      return db
        .select()
        .from(accounts)
        .where(eq(accounts.personId, p.personId))
        .orderBy(accounts.platform, accounts.handle);
    },

    /**
     * Adds an account on another platform to a lead (pasted by the owner),
     * then reads it if a connector exists. Returns null for an address that
     * is not an account, or the account when it already belongs to someone else.
     */
    async addAccount(input: { username: string; url: string }) {
      const ref = parseAccountUrl(input.url);
      if (!ref || ref.platform === "instagram")
        return { ok: false as const, reason: "not_account" };
      const [p] = await db
        .select({ igUserId: profiles.igUserId, personId: profiles.personId })
        .from(profiles)
        .where(eq(profiles.username, input.username.replace(/^@/, "").toLowerCase()));
      if (!p) return { ok: false as const, reason: "no_lead" };
      let personId = p.personId;
      if (!personId) {
        const [person] = await db.insert(people).values({}).returning({ id: people.id });
        personId = person?.id ?? null;
        await db.update(profiles).set({ personId }).where(eq(profiles.igUserId, p.igUserId));
      }
      if (!personId) return { ok: false as const, reason: "no_lead" };
      const [existing] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.platform, ref.platform), eq(accounts.handle, ref.handle)));
      if (existing && existing.personId !== personId)
        return { ok: false as const, reason: "taken", account: existing };
      const [added] = existing ? [existing] : await linkAccounts(personId, [ref], "manual");
      if (!added) return { ok: false as const, reason: "not_account" };
      return { ok: true as const, account: await refreshAccount(added.id) };
    },

    refreshAccount,

    /**
     * Reads accounts found in bios that were never read, for the platforms with
     * a connector (the daily task). YouTube's free quota covers about 10,000 a day.
     */
    async refreshPendingAccounts(limit = 200) {
      // Paid connectors (TikTok through Apify) are read only when the owner asks.
      const platforms = [...connectors.values()].filter((c) => !c.paid).map((c) => c.platform);
      if (platforms.length === 0) return 0;
      const pending = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(isNull(accounts.fetchedAt), inArray(accounts.platform, platforms)))
        .orderBy(accounts.createdAt)
        .limit(limit);
      for (const a of pending) await refreshAccount(a.id);
      return pending.length;
    },

    async removeAccount(id: string) {
      await db.delete(accounts).where(eq(accounts.id, id));
    },

    /**
     * Finds other-platform accounts in the bios and links of a project's leads
     * (no network: only what is already stored), then reads up to `read` of
     * them through the connectors. For leads collected before this existed.
     */
    async linkProjectAccounts(projectId: string, opts: { read?: number } = {}) {
      const rows = await db
        .select({
          igUserId: profiles.igUserId,
          personId: profiles.personId,
          bio: profiles.bio,
          externalUrl: profiles.externalUrl,
        })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(eq(leads.projectId, projectId))
        .limit(20_000);
      let found = 0;
      const toRead: string[] = [];
      for (const r of rows) {
        const refs = linkedAccounts(r.bio, r.externalUrl);
        if (refs.length === 0) continue;
        let personId = r.personId;
        if (!personId) {
          const [person] = await db.insert(people).values({}).returning({ id: people.id });
          personId = person?.id ?? null;
          await db.update(profiles).set({ personId }).where(eq(profiles.igUserId, r.igUserId));
        }
        if (!personId) continue;
        const added = await linkAccounts(personId, refs, "bio_link");
        found += added.length;
        for (const a of added) if (connectors.has(a.platform)) toRead.push(a.id);
      }
      let read = 0;
      for (const id of toRead.slice(0, opts.read ?? 50)) {
        await refreshAccount(id);
        read++;
      }
      return { leads: rows.length, found, read };
    },

    /** How many of a project's leads have an account on each platform. */
    async platformCounts(projectId: string) {
      const rows = await db
        .select({ platform: accounts.platform, n: sql<number>`count(distinct ${leads.id})::int` })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .innerJoin(accounts, eq(accounts.personId, profiles.personId))
        .where(eq(leads.projectId, projectId))
        .groupBy(accounts.platform);
      return Object.fromEntries(rows.map((r) => [r.platform, Number(r.n)])) as Record<
        string,
        number
      >;
    },

    /**
     * Trains the project's own model on the owner's decisions and scores every
     * lead with it. Too few decisions: nothing changes and the report says how
     * many more are needed.
     */
    async trainProjectModel(projectId: string) {
      const rows = await projectFeatures(projectId);
      const labelled = rows
        .map((r) => ({ ...r, label: outcomeOf(r.status) }))
        .filter((r): r is typeof r & { label: 0 | 1 } => r.label !== null);
      const model = trainModel(labelled.map((r) => ({ features: r.features, label: r.label })));
      const positives = labelled.filter((r) => r.label === 1).length;
      const negatives = labelled.length - positives;
      if (!model)
        return {
          trained: false as const,
          positives,
          negatives,
          needed: {
            positives: Math.max(0, MIN_POSITIVES - positives),
            negatives: Math.max(0, MIN_POSITIVES - negatives),
            total: Math.max(0, MIN_LABELLED - labelled.length),
          },
        };
      await db
        .update(projects)
        .set({ model: model as unknown as Record<string, unknown> })
        .where(eq(projects.id, projectId));
      // One update per probability value keeps this to at most 101 statements.
      const byProb = new Map<number, string[]>();
      for (const r of rows) {
        const p = predictWin(model, r.features);
        byProb.set(p, [...(byProb.get(p) ?? []), r.id]);
      }
      for (const [p, ids] of byProb)
        for (let i = 0; i < ids.length; i += 1000)
          await db
            .update(leads)
            .set({ winProb: p })
            .where(inArray(leads.id, ids.slice(i, i + 1000)));
      return { trained: true as const, positives, negatives, auc: model.auc, scored: rows.length };
    },

    /**
     * How good the scoring is, judged by the owner's real decisions: the AUC of
     * the AI score and of the project's own model (0.5 = guessing, 1 = perfect).
     */
    async evaluateScoring(projectId: string) {
      const rows = await projectFeatures(projectId);
      const labelled = rows
        .map((r) => ({ ...r, label: outcomeOf(r.status) }))
        .filter((r) => r.label !== null);
      const withAi = labelled.filter((r) => r.aiScore !== null);
      const project = await this.getProject(projectId);
      const model = (project?.model as TrainedModel | null | undefined) ?? null;
      return {
        labelled: labelled.length,
        positives: labelled.filter((r) => r.label === 1).length,
        aiScoreAuc: auc(
          withAi.map((r) => r.aiScore as number),
          withAi.map((r) => r.label as number),
        ),
        aiScored: withAi.length,
        model: model
          ? {
              auc: model.auc,
              trainedAt: model.trainedAt,
              trainedOn: model.trainedOn,
              explain: explainModel(model, 5),
            }
          : null,
      };
    },

    /**
     * Next period's collection budget split across the project's sources by
     * what they earned (see learn/budget), with each line matched to the
     * monitor that collects it, when there is one.
     */
    async budgetPlan(projectId: string, budgetUsd: number) {
      const perf = await this.sourcePerformance(projectId);
      const unit = router.unitCost("apify") || 0.0025;
      const plan = planBudget(perf.sources, { budgetUsd, costPerAccount: unit * 2 });
      const mons = await this.listMonitors(projectId);
      return {
        ...plan,
        budgetUsd,
        costPerAccount: unit * 2,
        lines: plan.lines.map((l) => {
          const m = mons.find((x) => x.sourceUrl === l.source);
          return { ...l, monitorId: m?.id ?? null, monitorEnabled: m?.enabled ?? null };
        }),
      };
    },

    /**
     * Applies a budget plan to the monitors (the owner approved it): stopped
     * sources are paused; the others collect what their share buys per run.
     */
    async applyBudgetPlan(projectId: string, lines: (BudgetLine & { monitorId: string | null })[]) {
      const mons = await this.listMonitors(projectId);
      let changed = 0;
      for (const l of lines) {
        const m = mons.find((x) => x.id === l.monitorId);
        if (!m) continue;
        if (l.decision === "stop") {
          await db.update(monitors).set({ enabled: false }).where(eq(monitors.id, m.id));
        } else {
          const runs = Math.max(1, Math.round(30 / m.everyDays));
          const limit = Math.min(maxLimit, Math.max(10, Math.floor(l.accounts / runs)));
          await db.update(monitors).set({ enabled: true, limit }).where(eq(monitors.id, m.id));
        }
        changed++;
      }
      return { changed };
    },

    /** Whether new sources can be found from customers' follows (needs Apify). */
    get suggestionsAvailable() {
      return !!deps.following;
    },

    /** What suggestSources would cost, before running it. */
    suggestCost(seeds = 8, perSeed = 150) {
      return deps.following
        ? Math.round(((deps.following.followingCostPer1k * seeds * perSeed) / 1000) * 100) / 100
        : null;
    },

    /**
     * New sources from the network: the accounts several of the owner's best
     * leads (customers first, then interested) follow, that are not watched
     * yet. Saved so the page can show them without paying again.
     */
    async suggestSources(projectId: string, opts: { seeds?: number; perSeed?: number } = {}) {
      if (!deps.following) throw new Error("اكتشاف المصادر يحتاج APIFY_TOKEN");
      const seeds = await db
        .select({ username: profiles.username })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(
          and(eq(leads.projectId, projectId), inArray(leads.status, ["customer", "interested"])),
        )
        .orderBy(sql`${leads.dealValue} desc nulls last`, desc(leads.statusAt))
        .limit(Math.min(opts.seeds ?? 8, 20));
      if (seeds.length < 3) throw new Error("نحتاج 3 عملاء أو مهتمين على الأقل لنعرف من يتابعون");
      const counts = new Map<string, number>();
      let read = 0;
      for (const s of seeds) {
        try {
          const follows = await deps.following.listFollowing(s.username, opts.perSeed ?? 150);
          read += follows.length;
          for (const f of new Set(follows)) counts.set(f, (counts.get(f) ?? 0) + 1);
        } catch {
          // A private or missing account is skipped.
        }
      }
      const watched = new Set(
        (await this.listMonitors(projectId))
          .map((m) => /instagram\.com\/([A-Za-z0-9._]{1,30})/.exec(m.sourceUrl)?.[1]?.toLowerCase())
          .filter(Boolean),
      );
      const seedNames = new Set(seeds.map((s) => s.username));
      const suggestions = [...counts.entries()]
        .filter(([u, n]) => n >= 2 && !watched.has(u) && !seedNames.has(u))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([username, followedBy]) => ({ username, followedBy }));
      const result = {
        at: new Date().toISOString(),
        seeds: seeds.length,
        read,
        costUsd: Math.round(((deps.following.followingCostPer1k * read) / 1000) * 100) / 100,
        suggestions,
      };
      await setValue(`suggest:${projectId}`, result, 60 * 86_400_000);
      return result;
    },

    async lastSuggestions(projectId: string) {
      return getValue<{
        at: string;
        seeds: number;
        read: number;
        costUsd: number;
        suggestions: { username: string; followedBy: number }[];
      }>(`suggest:${projectId}`);
    },

    /**
     * The weekly analyst: retrains the project's model, reads its revenue by
     * source, the budget plan, competitors' growth and site changes, and the
     * best new leads, then writes the plan (with AI when available). Budget
     * changes are saved as a pending plan and applied only when approved.
     */
    async weeklyPlan(projectId: string, budgetUsd: number, now = new Date()) {
      const project = await this.getProject(projectId);
      if (!project) throw new Error("Project not found");
      const model = await this.trainProjectModel(projectId);
      const [perf, budget, ev] = await Promise.all([
        this.sourcePerformance(projectId, { since: new Date(now.getTime() - 90 * 86_400_000) }),
        this.budgetPlan(projectId, budgetUsd),
        this.evaluateScoring(projectId),
      ]);
      const since = new Date(now.getTime() - 7 * 86_400_000);
      const changedSites = (await this.listSiteWatches()).filter(
        (w) => w.lastChangedAt && w.lastChangedAt >= since,
      );
      const best = await leadsPage({ projectId, status: "new", minWinProb: 60, limit: 5 });
      const rising = await leadsPage({ projectId, signal: "rising", limit: 5 });
      const changes = budget.lines.filter((l) => l.monitorId && l.decision !== "keep");
      const data = {
        project: project.name,
        revenue90d: perf.totals,
        topSources: perf.sources.slice(0, 5).map((s) => ({
          source: s.source,
          customers: s.customers,
          revenue: s.revenue,
          cost: s.costUsd,
        })),
        model: model.trained ? { auc: model.auc } : { needed: model.needed },
        aiScoreAuc: ev.aiScoreAuc,
        budget: {
          usd: budgetUsd,
          changes: changes.map((l) => ({ source: l.source, decision: l.decision, usd: l.usd })),
        },
        competitorSiteChanges: changedSites.map((w) => ({
          page: w.label ?? w.url,
          added: w.lastDiff?.added.slice(0, 3) ?? [],
        })),
        contactFirst: best.leads.map((l) => ({ username: l.username, winProb: l.winProb })),
        rising: rising.leads.map((l) => l.username),
      };
      let text = "";
      if (scorer?.weeklyBrief) {
        try {
          text = await scorer.weeklyBrief(data);
        } catch {
          text = "";
        }
      }
      if (!text) {
        const money = (n: number) => `$${n.toLocaleString("en", { maximumFractionDigits: 2 })}`;
        text = [
          `خطة الأسبوع · ${project.name}`,
          `آخر 90 يوماً: ${money(perf.totals.revenue)} من ${perf.totals.customers} عميل، بتكلفة جمع ${money(perf.totals.costUsd)}.`,
          perf.sources[0]
            ? `الأفضل: ${perf.sources[0].source} (${perf.sources[0].customers} عميل).`
            : "",
          model.trained
            ? `نموذجك محدَّث (دقة الترتيب ${Math.round((model.auc ?? 0) * 100)}%).`
            : `النموذج ينتظر قرارات أكثر: سجّل ${model.needed.positives} عملاء و${model.needed.negatives} مرفوضين على الأقل.`,
          changes.length
            ? `تغييرات الميزانية المقترحة: ${changes.map((l) => `${l.decision === "stop" ? "أوقف" : l.decision === "increase" ? "زِد" : l.decision === "decrease" ? "خفّض" : "جرّب"} ${l.source}`).join("، ")}.`
            : "لا تغيير في الميزانية.",
          best.leads.length
            ? `ابدأ بـ: ${best.leads.map((l) => `@${l.username} (${l.winProb}%)`).join("، ")}.`
            : "",
          rising.leads.length
            ? `ينمون بسرعة: ${rising.leads.map((l) => `@${l.username}`).join("، ")}.`
            : "",
          changedSites.length ? `تغيّرت ${changedSites.length} من صفحات المنافسين هذا الأسبوع.` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      const id = randomBytes(6).toString("hex");
      await setValue(
        `plan:${id}`,
        { id, projectId, createdAt: now.toISOString(), text, lines: changes, applied: false },
        14 * 86_400_000,
      );
      await setValue(`plan:last:${projectId}`, id, 14 * 86_400_000);
      return { id, text, changes: changes.length };
    },

    async getPlan(id: string) {
      return getValue<{
        id: string;
        projectId: string;
        createdAt: string;
        text: string;
        lines: (BudgetLine & { monitorId: string | null })[];
        applied: boolean;
      }>(`plan:${id}`);
    },

    async lastPlan(projectId: string) {
      const id = await getValue<string>(`plan:last:${projectId}`);
      return id ? this.getPlan(id) : null;
    },

    /** Applies a weekly plan the owner approved (once). */
    async approvePlan(id: string) {
      const plan = await this.getPlan(id);
      if (!plan) return { ok: false as const, reason: "expired" };
      if (plan.applied) return { ok: false as const, reason: "applied" };
      const r = await this.applyBudgetPlan(plan.projectId, plan.lines);
      await setValue(`plan:${id}`, { ...plan, applied: true }, 14 * 86_400_000);
      await this.audit({
        actor: "owner",
        action: "plan.approve",
        detail: { id, changed: r.changed },
      });
      return { ok: true as const, changed: r.changed };
    },

    ...brokerMethods(featureCtx),

    ...ownMethods(featureCtx),

    /** Changes many leads at once: status, follow-up date, or both. Returns how many changed. */
    async bulkUpdateLeads(input: {
      projectId: string;
      usernames: string[];
      status?: LeadStatus;
      followUpAt?: Date | null;
    }) {
      const names = [
        ...new Set(input.usernames.map((u) => u.replace(/^@/, "").toLowerCase())),
      ].slice(0, 500);
      if (names.length === 0 || (input.status === undefined && input.followUpAt === undefined))
        return 0;
      const ids = db
        .select({ id: profiles.igUserId })
        .from(profiles)
        .where(inArray(profiles.username, names));
      const updated = await db
        .update(leads)
        .set({
          ...(input.status ? { status: input.status, statusAt: new Date() } : {}),
          ...(input.followUpAt !== undefined ? { followUpAt: input.followUpAt } : {}),
        })
        .where(and(eq(leads.projectId, input.projectId), inArray(leads.profileId, ids)))
        .returning({ id: leads.id });
      const text = [
        input.status ? `الحالة: ${STATUS_AR[input.status] ?? input.status}` : "",
        input.followUpAt !== undefined
          ? input.followUpAt
            ? `تذكير متابعة يوم ${input.followUpAt.toISOString().slice(0, 10)}`
            : "أُلغي تذكير المتابعة"
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      if (updated.length > 0)
        await db
          .insert(leadEvents)
          .values(updated.map((u) => ({ leadId: u.id, kind: "status", text: `${text} (جماعي)` })));
      return updated.length;
    },

    /** Adds the owner's note to a lead's history. */
    async addLeadNote(input: { projectId: string; username: string; text: string }) {
      const text = input.text.trim().slice(0, 2000);
      if (!text) return false;
      const [row] = await db
        .select({ id: leads.id })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(
          and(
            eq(leads.projectId, input.projectId),
            eq(profiles.username, input.username.replace(/^@/, "").toLowerCase()),
          ),
        );
      if (!row) return false;
      await db.insert(leadEvents).values({ leadId: row.id, kind: "note", text });
      return true;
    },

    /** A lead with its notes and history, newest first. */
    async leadDetail(projectId: string, username: string) {
      const u = username.replace(/^@/, "").toLowerCase();
      const [row] = await leadsPage({ projectId, q: u, limit: 20 }).then((r) =>
        r.leads.filter((l) => l.username === u),
      );
      if (!row) return null;
      const events = await db
        .select({ at: leadEvents.at, kind: leadEvents.kind, text: leadEvents.text })
        .from(leadEvents)
        .innerJoin(leads, eq(leads.id, leadEvents.leadId))
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(and(eq(leads.projectId, projectId), eq(profiles.username, u)))
        .orderBy(desc(leadEvents.at))
        .limit(100);
      const [p] = await db
        .select({ bio: profiles.bio })
        .from(profiles)
        .where(eq(profiles.username, u));
      const [pp] = await db
        .select({ personId: profiles.personId })
        .from(profiles)
        .where(eq(profiles.username, u));
      const accs = pp?.personId
        ? await db
            .select()
            .from(accounts)
            .where(eq(accounts.personId, pp.personId))
            .orderBy(accounts.platform, accounts.handle)
        : [];
      return { lead: row, bio: p?.bio ?? null, events, accounts: accs };
    },

    /** Understands a question in plain language and returns the matching leads. */
    async askLeads(projectId: string, question: string, limit = 50) {
      if (!scorer?.parseQuery)
        throw new ScoringUnavailableError("Questions in plain language need ANTHROPIC_API_KEY");
      const query: LeadQuery = await scorer.parseQuery(question);
      const page = await leadsPage({ ...query, projectId, limit });
      return { query, leads: page.leads };
    },

    /** Leads with a follow-up date, for the calendar feed. */
    async upcomingFollowUps(limit = 500) {
      return db
        .select({
          username: profiles.username,
          fullName: profiles.fullName,
          at: leads.followUpAt,
          status: leads.status,
          project: projects.name,
          projectId: projects.id,
          note: leads.statusNote,
        })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .innerJoin(projects, eq(projects.id, leads.projectId))
        .where(isNotNull(leads.followUpAt))
        .orderBy(leads.followUpAt)
        .limit(limit);
    },

    /**
     * Reads a competitor's public profile and recent posts: what works, when
     * they post, growth since the last look, and (with AI) content ideas.
     */
    async analyzeCompetitor(input: { username: string; projectId?: string }) {
      const username = input.username.replace(/^@/, "").trim().toLowerCase();
      await loadRouterState();
      const { profile } = await router.getProfile(username);
      await saveRouterState();
      const [last] = await db
        .select()
        .from(competitorSnapshots)
        .where(eq(competitorSnapshots.username, username))
        .orderBy(desc(competitorSnapshots.at))
        .limit(1);
      await db
        .insert(competitorSnapshots)
        .values({ username, followers: profile.followers ?? null, posts: profile.posts ?? null });
      const analysis = analyzePosts(profile.recentPosts, profile.followers, config.timeZone);
      const growth = last
        ? {
            since: last.at,
            followers: (profile.followers ?? 0) - (last.followers ?? 0),
            percent: growthPercent(last.followers, profile.followers ?? null),
          }
        : null;
      let brief: string | null = null;
      if (scorer?.competitorBrief) {
        const project = input.projectId ? await this.getProject(input.projectId) : null;
        try {
          brief =
            (await scorer.competitorBrief(
              {
                username,
                bio: profile.bio ?? null,
                category: profile.category ?? null,
                followers: profile.followers ?? null,
                growthPercent: growth?.percent ?? null,
                analysis,
                captions: (profile.recentPosts ?? [])
                  .map((p) => p.caption ?? "")
                  .filter(Boolean)
                  .slice(0, 8),
              },
              project?.aiCriteria ?? "",
            )) || null;
        } catch {
          brief = null;
        }
      }
      return {
        username,
        fullName: profile.fullName ?? null,
        bio: profile.bio ?? null,
        category: profile.category ?? null,
        followers: profile.followers ?? null,
        following: profile.following ?? null,
        posts: profile.posts ?? null,
        analysis,
        growth,
        brief,
      };
    },

    /**
     * Records the follower count of every competitor a monitor watches (once a
     * day) and alerts on unusual growth, which usually means an ad campaign.
     */
    async snapshotCompetitors(now = new Date(), thresholdPercent = 3) {
      const watched = await db
        .select({ url: monitors.sourceUrl, type: monitors.sourceType })
        .from(monitors)
        .where(eq(monitors.enabled, true));
      const names = [
        ...new Set(
          watched
            .filter((w) => w.type === "followers" || w.type === "profile")
            .map((w) => /instagram\.com\/([A-Za-z0-9._]{1,30})/.exec(w.url)?.[1]?.toLowerCase())
            .filter((u): u is string => !!u),
        ),
      ].slice(0, 20);
      const alerts: string[] = [];
      await loadRouterState();
      for (const username of names) {
        const [last] = await db
          .select()
          .from(competitorSnapshots)
          .where(eq(competitorSnapshots.username, username))
          .orderBy(desc(competitorSnapshots.at))
          .limit(1);
        if (last && now.getTime() - last.at.getTime() < 20 * 3_600_000) continue;
        let followers: number | null = null;
        let posts: number | null = null;
        try {
          const { profile } = await router.getProfile(username);
          followers = profile.followers ?? null;
          posts = profile.posts ?? null;
        } catch {
          continue;
        }
        await db.insert(competitorSnapshots).values({ username, followers, posts, at: now });
        const pct = last ? growthPercent(last.followers, followers) : null;
        if (pct !== null && Math.abs(pct) >= thresholdPercent) {
          const diff = (followers ?? 0) - (last?.followers ?? 0);
          alerts.push(`@${username}: ${diff > 0 ? "+" : ""}${diff.toLocaleString("en")} (${pct}%)`);
        }
      }
      await saveRouterState();
      if (alerts.length > 0)
        await notify({
          type: "system",
          level: "warn",
          title: "نمو غير عادي عند منافس",
          body: `${alerts.join("\n")}\nغالباً حملة إعلانية أو منشور انتشر. حلّل حسابه من صفحة المنافسين.`,
          url: "/competitors",
          key: `growth:${now.toISOString().slice(0, 10)}`,
        });
      return { checked: names.length, alerts };
    },

    /** Follower history of a competitor, oldest first. */
    async competitorHistory(username: string, limit = 60) {
      const rows = await db
        .select({ at: competitorSnapshots.at, followers: competitorSnapshots.followers })
        .from(competitorSnapshots)
        .where(eq(competitorSnapshots.username, username.replace(/^@/, "").toLowerCase()))
        .orderBy(desc(competitorSnapshots.at))
        .limit(limit);
      return rows.reverse();
    },

    /** Everything needed to restore the owner's work, as plain rows (no secrets). */
    async exportBackup() {
      const [p, l, pr, ev, m, s, pa, be, op, oc, im] = await Promise.all([
        db.select().from(projects),
        db.select().from(leads),
        db.select().from(profiles),
        db.select().from(leadEvents),
        db.select().from(monitors),
        db.select().from(suppression),
        db.select().from(partners),
        db.select().from(brokerEvents),
        db.select().from(ownPosts),
        db.select().from(ownComments),
        db.select().from(inboxMessages),
      ]);
      return {
        version: 2,
        createdAt: new Date().toISOString(),
        projects: p,
        leads: l,
        profiles: pr,
        leadEvents: ev,
        monitors: m,
        suppression: s,
        partners: pa,
        brokerEvents: be,
        ownPosts: op,
        ownComments: oc,
        inboxMessages: im,
      };
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

    ...marketMethods(featureCtx),

    ...engineMethods(featureCtx),

    ...opsMethods(featureCtx),

    ...usageMethods(featureCtx),

    ...saverMethods(featureCtx),

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
      // Competitor growth this week, from the daily snapshots.
      const growth = await db
        .select({
          username: competitorSnapshots.username,
          first: sql<number>`(array_agg(${competitorSnapshots.followers} order by ${competitorSnapshots.at} asc))[1]`,
          last: sql<number>`(array_agg(${competitorSnapshots.followers} order by ${competitorSnapshots.at} desc))[1]`,
        })
        .from(competitorSnapshots)
        .where(and(gte(competitorSnapshots.at, since), isNotNull(competitorSnapshots.followers)))
        .groupBy(competitorSnapshots.username)
        .having(sql`count(*) >= 2`);
      const growthLines = growth
        .map((g) => {
          const pct = growthPercent(Number(g.first), Number(g.last));
          const diff = Number(g.last) - Number(g.first);
          return `@${g.username} ${diff >= 0 ? "+" : ""}${diff.toLocaleString("en")}${pct !== null ? ` (${pct}%)` : ""}`;
        })
        .slice(0, 5);
      const repeat = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(leads)
        .where(and(gte(leads.createdAt, since), gte(leads.sourceCount, 2)));
      const body = [
        `عملاء جدد: ${t?.leads ?? 0} (بوسيلة تواصل: ${t?.contact ?? 0})`,
        repeat[0]?.n ? `يتابعون أكثر من منافس: ${repeat[0].n}` : "",
        growthLines.length ? `نمو المنافسين: ${growthLines.join("، ")}` : "",
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
  return api;
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
  if (job.sourceType === "search")
    return {
      type: "search",
      query: new URL(job.sourceUrl).searchParams.get("q") ?? "",
      url: job.sourceUrl,
    };
  if (job.sourceType === "location")
    return { type: "location", locationId: parts[2] ?? "", url: job.sourceUrl };
  if (job.sourceType === "similar")
    return { type: "similar", username: parts[0] ?? "", url: job.sourceUrl };
  return { type: "profile", username: parts[0] ?? "", url: job.sourceUrl };
}
