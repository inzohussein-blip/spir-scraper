import { counters, ephemeral, jobs, notifications, projects, suppression } from "@scrapers/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { createMxChecker, fetchLinkPage, type ResolveDeps } from "../extract/index.js";
import { type NotificationInput, redactSecrets } from "../notify.js";
import type { LateApi, ScrapersDeps } from "./shared.js";

/** Shared stores: key/value, counters, provider router state, notifications, job costs and progress, suppression. */
export function createStore(deps: ScrapersDeps) {
  const { db, router, config } = deps;
  let bound: LateApi | null = null;

  const lateApi = (): LateApi => {
    if (!bound) throw new Error("service not ready");
    return bound;
  };

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

  /** Which of these hashes are on the suppression list (one query). */
  async function suppressedHashes(hashes: string[]): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    const rows = await db
      .select({ h: suppression.valueHash })
      .from(suppression)
      .where(inArray(suppression.valueHash, hashes));
    return new Set(rows.map((r) => r.h));
  }

  return {
    lateApi,
    sinks,
    resolveDeps,
    cacheDays,
    connectors,
    pepper,
    getValue,
    setValue,
    claimOnce,
    hitCounter,
    ROUTER_KEY,
    loadRouterState,
    saveRouterState,
    notify,
    jobLabel,
    maxLimit,
    addCost,
    bump,
    suppressedHashes,
    /** Lets the pipeline call public methods (set once by createScrapers). */
    bindApi(api: LateApi) {
      bound = api;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
