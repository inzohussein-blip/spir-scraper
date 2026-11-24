import { engineEvents, engineQueue, engineRuns, profiles } from "@scrapers/db";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { linkedAccounts, profileQuality } from "../../extract/index.js";
import { mentionsIn } from "../../extract/mentions.js";
import { isValidUsername, uploadSource } from "../../source.js";
import type { RawProfile } from "../../types.js";
import type { FeatureContext } from "./context.js";

/** Speed and rest settings of the Spir engine (one home connection reads for all runs). */
export interface EngineSettings {
  /** Master switch. */
  enabled: boolean;
  /** Seconds between two accounts (at least 20). */
  intervalSec: number;
  /** Extra random seconds added to each wait, so the rhythm is not regular. */
  jitterSec: number;
  /** Accounts read in any 24 hours, across all runs. */
  dailyCap: number;
  /** Local hours (the platform's time zone) when the engine sleeps; equal values: never. */
  quietFrom: number;
  quietTo: number;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  enabled: true,
  intervalSec: 60,
  jitterSec: 20,
  dailyCap: 800,
  quietFrom: 2,
  quietTo: 7,
};

export type EngineDecision =
  | { action: "wait"; seconds: number; reason: string }
  | { action: "read"; item: { id: string; username: string } };

export type EngineReport =
  | { itemId: string; status: "ok"; profile: RawProfile }
  | {
      itemId: string;
      status: "not_found" | "rate_limited" | "blocked" | "error";
      message?: string;
    };

const SETTINGS_KEY = "engine:settings";
const REST_KEY = "engine:resting";
const LAST_KEY = "engine:last";
const WORKER_KEY = "engine:worker";
const YEAR = 365 * 86_400_000;
/** Accepted accounts are sent to the project in groups of this size. */
const SEND_EVERY = 25;
const LEASE_MS = 10 * 60_000;

function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone })
    .formatToParts(now)
    .find((p) => p.type === "hour")?.value;
  return Number(h ?? now.getUTCHours());
}

export function inQuietHours(s: EngineSettings, hour: number): boolean {
  if (s.quietFrom === s.quietTo) return false;
  return s.quietFrom < s.quietTo
    ? hour >= s.quietFrom && hour < s.quietTo
    : hour >= s.quietFrom || hour < s.quietTo;
}

/** Rest after Instagram refuses: 30 minutes, doubling, at most 12 hours. */
export function restMinutes(strikes: number): number {
  return Math.min(30 * 2 ** Math.max(0, strikes - 1), 12 * 60);
}

/** Accounts a profile points to: @mentions in the bio and captions, and linked Instagram pages. */
export function engineCandidates(p: RawProfile): { username: string; weight: number }[] {
  const out = new Map<string, number>();
  const add = (u: string, w: number) => {
    const name = u.toLowerCase();
    if (name === p.username.toLowerCase() || !isValidUsername(name)) return;
    out.set(name, (out.get(name) ?? 0) + w);
  };
  for (const u of mentionsIn(p.bio)) add(u, 3);
  for (const ref of linkedAccounts(p.bio, p.externalUrl))
    if (ref.platform === "instagram") add(ref.handle, 2);
  for (const post of p.recentPosts ?? []) for (const u of mentionsIn(post.caption)) add(u, 1);
  return [...out.entries()]
    .map(([username, weight]) => ({ username, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 30);
}

/** The words of a run found in an account's name, bio, category and captions. */
export function keywordHits(p: RawProfile, keywords: string[] | null): string[] {
  if (!keywords?.length) return [];
  const text = [
    p.username,
    p.fullName,
    p.bio,
    p.category,
    ...(p.recentPosts ?? []).map((x) => x.caption),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return keywords.filter((k) => k.trim() && text.includes(k.trim().toLowerCase()));
}

/**
 * The Spir engine: a slow, Apify-like crawler that runs on the owner's home
 * connection. The home worker asks what to read next and reports what it
 * read; the platform decides the pace (interval, quiet hours, daily cap,
 * rests after a refusal), so speed is controlled from the dashboard alone.
 */
export function engineMethods(ctx: FeatureContext) {
  const { db, notify, getValue, setValue, saveProfile, timeZone, self } = ctx;

  async function settings(): Promise<EngineSettings> {
    return {
      ...DEFAULT_ENGINE_SETTINGS,
      ...((await getValue<Partial<EngineSettings>>(SETTINGS_KEY)) ?? {}),
    };
  }

  async function log(runId: string | null, kind: string, text: string) {
    await db.insert(engineEvents).values({ runId, kind, text: text.slice(0, 500) });
  }

  async function readLastDay(now: Date) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(engineQueue)
      .where(gte(engineQueue.readAt, new Date(now.getTime() - 86_400_000)));
    return Number(r?.n ?? 0);
  }

  async function bump(runId: string, key: "read" | "accepted" | "skipped" | "failed") {
    await db
      .update(engineRuns)
      .set({
        counts: sql`jsonb_set(${engineRuns.counts}, ${`{${key}}`}, to_jsonb(coalesce((${engineRuns.counts}->>${key})::int, 0) + 1))`,
      })
      .where(eq(engineRuns.id, runId));
  }

  /** Sends accepted accounts to the run's project (read from the profile cache, never paid again). */
  async function sendAccepted(runId: string, force = false) {
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    if (!run) return 0;
    const pending = await db
      .select({ id: engineQueue.id, username: engineQueue.username })
      .from(engineQueue)
      .where(
        and(
          eq(engineQueue.runId, runId),
          eq(engineQueue.accepted, true),
          isNull(engineQueue.jobId),
        ),
      )
      .limit(500);
    if (pending.length === 0 || (!force && pending.length < SEND_EVERY)) return 0;
    const { job } = await self().startJob({
      projectId: run.projectId,
      source: uploadSource(
        pending.map((p) => p.username),
        `محرك Spir: ${run.name}`,
      ),
      limit: pending.length,
    });
    await db
      .update(engineQueue)
      .set({ jobId: job.id })
      .where(
        inArray(
          engineQueue.id,
          pending.map((p) => p.id),
        ),
      );
    return pending.length;
  }

  async function finishRun(runId: string, reason: string) {
    const [run] = await db
      .update(engineRuns)
      .set({ status: "done", finishedAt: new Date() })
      .where(and(eq(engineRuns.id, runId), eq(engineRuns.status, "active")))
      .returning();
    if (!run) return;
    await sendAccepted(runId, true);
    await log(runId, "done", reason);
    await notify({
      type: "system",
      level: "ok",
      title: `انتهى تشغيل محرك Spir: ${run.name}`,
      body: `قرأ ${run.counts.read ?? 0} حساباً، وقُبل ${run.counts.accepted ?? 0}. ${reason}`,
      url: `/engine/${run.id}`,
      key: `engine-done:${run.id}`,
    });
  }

  async function next(now = new Date()): Promise<EngineDecision> {
    await setValue(WORKER_KEY, { lastSeen: now.toISOString() }, 30 * 86_400_000);
    const s = await settings();
    if (!s.enabled) return { action: "wait", seconds: 300, reason: "paused" };
    const rest = await getValue<{ until: number; strikes: number }>(REST_KEY);
    if (rest && rest.until > now.getTime())
      return {
        action: "wait",
        seconds: Math.min(3600, Math.ceil((rest.until - now.getTime()) / 1000)),
        reason: "resting",
      };
    if (inQuietHours(s, localHour(now, timeZone)))
      return { action: "wait", seconds: 900, reason: "quiet" };
    if ((await readLastDay(now)) >= s.dailyCap)
      return { action: "wait", seconds: 1800, reason: "daily_cap" };
    // The platform keeps the pace, whatever the worker does.
    const last = (await getValue<number>(LAST_KEY)) ?? 0;
    const gap = Math.max(20, s.intervalSec) * 1000;
    if (now.getTime() - last < gap)
      return {
        action: "wait",
        seconds: Math.ceil((last + gap - now.getTime()) / 1000 + Math.random() * s.jitterSec),
        reason: "pace",
      };

    // Leases that were never reported go back to the queue.
    await db
      .update(engineQueue)
      .set({ status: "queued", leasedUntil: null })
      .where(and(eq(engineQueue.status, "leased"), lt(engineQueue.leasedUntil, now)));
    // Accepted accounts waiting too long are sent even if the group is not full.
    const stale = await db
      .selectDistinct({ runId: engineQueue.runId })
      .from(engineQueue)
      .where(
        and(
          eq(engineQueue.accepted, true),
          isNull(engineQueue.jobId),
          lt(engineQueue.readAt, new Date(now.getTime() - 30 * 60_000)),
        ),
      );
    for (const r of stale) await sendAccepted(r.runId, true);

    const [item] = await db
      .select({ id: engineQueue.id, username: engineQueue.username })
      .from(engineQueue)
      .innerJoin(engineRuns, eq(engineRuns.id, engineQueue.runId))
      .where(and(eq(engineRuns.status, "active"), eq(engineQueue.status, "queued")))
      .orderBy(desc(engineQueue.priority), asc(engineQueue.depth), asc(engineQueue.id))
      .limit(1);
    if (!item) return { action: "wait", seconds: 300, reason: "idle" };
    await db
      .update(engineQueue)
      .set({
        status: "leased",
        leasedUntil: new Date(now.getTime() + LEASE_MS),
        attempts: sql`${engineQueue.attempts} + 1`,
      })
      .where(eq(engineQueue.id, item.id));
    await setValue(LAST_KEY, now.getTime(), 7 * 86_400_000);
    return { action: "read", item };
  }

  async function report(r: EngineReport, now = new Date()) {
    const [item] = await db.select().from(engineQueue).where(eq(engineQueue.id, r.itemId));
    if (!item) return;
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, item.runId));
    if (!run) return;

    if (r.status === "rate_limited" || r.status === "blocked") {
      const prev = await getValue<{ until: number; strikes: number }>(REST_KEY);
      const strikes = (prev?.strikes ?? 0) + 1;
      const minutes = restMinutes(strikes);
      await setValue(
        REST_KEY,
        { until: now.getTime() + minutes * 60_000, strikes },
        7 * 86_400_000,
      );
      await db
        .update(engineQueue)
        .set({
          status: "queued",
          leasedUntil: null,
          attempts: sql`greatest(${engineQueue.attempts} - 1, 0)`,
        })
        .where(eq(engineQueue.id, item.id));
      await log(null, "rest", `إنستقرام طلب التمهل (${r.status}). استراحة ${minutes} دقيقة.`);
      await notify({
        type: "system",
        level: "warn",
        title: "محرك Spir يستريح",
        body: `إنستقرام طلب التمهل، فتوقف المحرك ${minutes} دقيقة ثم يعود وحده. إن تكرر كثيراً، أبطئ السرعة من صفحة المحرك.`,
        url: "/engine",
        key: `engine-rest:${now.toISOString().slice(0, 13)}`,
      });
      return;
    }
    if (r.status === "error") {
      const failed = item.attempts >= 3;
      await db
        .update(engineQueue)
        .set({
          status: failed ? "failed" : "queued",
          leasedUntil: null,
          note: r.message?.slice(0, 200) ?? null,
          ...(failed ? { readAt: now } : {}),
        })
        .where(eq(engineQueue.id, item.id));
      if (failed) await bump(run.id, "failed");
    } else if (r.status === "not_found") {
      await db
        .update(engineQueue)
        .set({ status: "done", readAt: now, accepted: false, note: "غير موجود أو خاص" })
        .where(eq(engineQueue.id, item.id));
      await bump(run.id, "read");
      await bump(run.id, "skipped");
    } else if (r.status === "ok") {
      const p = { ...r.profile, username: r.profile.username.toLowerCase() };
      const quality = profileQuality(p);
      await saveProfile(p, "worker", quality);
      const hits = keywordHits(p, run.keywords);
      const relevant = !run.keywords?.length || hits.length > 0;
      const bigEnough = (p.followers ?? 0) >= run.minFollowers;
      const accepted = relevant && bigEnough;
      await db
        .update(engineQueue)
        .set({
          status: "done",
          readAt: now,
          accepted,
          followers: p.followers ?? null,
          note: accepted
            ? hits.slice(0, 3).join("، ") || null
            : !relevant
              ? "لا يطابق الكلمات"
              : `أقل من ${run.minFollowers} متابع`,
        })
        .where(eq(engineQueue.id, item.id));
      await bump(run.id, "read");
      await bump(run.id, accepted ? "accepted" : "skipped");
      await setValue(REST_KEY, { until: 0, strikes: 0 }, 7 * 86_400_000);

      // Follow who it mentions, while the crawl stays on topic.
      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(engineQueue)
        .where(eq(engineQueue.runId, run.id));
      if (
        item.depth < run.maxDepth &&
        (relevant || item.depth === 0) &&
        Number(n) < run.maxAccounts * 5
      ) {
        const bonus = hits.length > 0 ? 2 : 0;
        const rows = engineCandidates(p).map((c) => ({
          runId: run.id,
          username: c.username,
          depth: item.depth + 1,
          priority: c.weight + bonus,
          referrer: p.username,
        }));
        if (rows.length > 0)
          await db
            .insert(engineQueue)
            .values(rows)
            .onConflictDoUpdate({
              target: [engineQueue.runId, engineQueue.username],
              // Mentioned again by another account: read it sooner.
              set: { priority: sql`${engineQueue.priority} + excluded.priority` },
              setWhere: eq(engineQueue.status, "queued"),
            });
      }
      if (accepted) await sendAccepted(run.id);
    }

    const [updated] = await db.select().from(engineRuns).where(eq(engineRuns.id, run.id));
    if ((updated?.counts.read ?? 0) >= run.maxAccounts) {
      await finishRun(run.id, `بلغ الحد (${run.maxAccounts} حساب).`);
      return;
    }
    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(engineQueue)
      .where(and(eq(engineQueue.runId, run.id), inArray(engineQueue.status, ["queued", "leased"])));
    if (Number(left?.n ?? 0) === 0) await finishRun(run.id, "لم يبق حسابات في الطابور.");
  }

  return {
    engineSettings: settings,

    async saveEngineSettings(input: Partial<EngineSettings>) {
      const s = { ...(await settings()), ...input };
      s.intervalSec = Math.max(20, Math.min(3600, Math.round(s.intervalSec)));
      s.jitterSec = Math.max(0, Math.min(600, Math.round(s.jitterSec)));
      s.dailyCap = Math.max(1, Math.min(5000, Math.round(s.dailyCap)));
      s.quietFrom = Math.max(0, Math.min(23, Math.round(s.quietFrom)));
      s.quietTo = Math.max(0, Math.min(23, Math.round(s.quietTo)));
      await setValue(SETTINGS_KEY, s, 10 * YEAR);
      return s;
    },

    /** What the engine is doing now, for the dashboard. */
    async engineStatus(now = new Date()) {
      const s = await settings();
      const worker = await getValue<{ lastSeen: string }>(WORKER_KEY);
      const rest = await getValue<{ until: number; strikes: number }>(REST_KEY);
      const readToday = await readLastDay(now);
      const [queued] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(engineQueue)
        .innerJoin(engineRuns, eq(engineRuns.id, engineQueue.runId))
        .where(and(eq(engineRuns.status, "active"), eq(engineQueue.status, "queued")));
      const seenAgo = worker ? now.getTime() - new Date(worker.lastSeen).getTime() : null;
      const state = !s.enabled
        ? "paused"
        : seenAgo === null || seenAgo > 2 * 3600_000
          ? "no_worker"
          : rest && rest.until > now.getTime()
            ? "resting"
            : inQuietHours(s, localHour(now, timeZone))
              ? "quiet"
              : readToday >= s.dailyCap
                ? "daily_cap"
                : Number(queued?.n ?? 0) === 0
                  ? "idle"
                  : "running";
      return {
        state,
        settings: s,
        workerLastSeen: worker?.lastSeen ?? null,
        restingUntil: rest && rest.until > now.getTime() ? new Date(rest.until) : null,
        readToday,
        queued: Number(queued?.n ?? 0),
      };
    },

    async createEngineRun(input: {
      name: string;
      projectId: string;
      seeds: string[];
      keywords?: string[];
      maxDepth?: number;
      maxAccounts?: number;
      minFollowers?: number;
    }) {
      const seeds = [
        ...new Set(
          input.seeds.map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(isValidUsername),
        ),
      ].slice(0, 5000);
      if (seeds.length === 0) throw new Error("أضف حساباً واحداً على الأقل للبدء منه");
      const [run] = await db
        .insert(engineRuns)
        .values({
          name: input.name.trim().slice(0, 80) || "تشغيل",
          projectId: input.projectId,
          seeds,
          keywords:
            input.keywords
              ?.map((k) => k.trim())
              .filter(Boolean)
              .slice(0, 30) ?? null,
          maxDepth: Math.max(0, Math.min(5, input.maxDepth ?? 2)),
          maxAccounts: Math.max(1, Math.min(50_000, input.maxAccounts ?? 500)),
          minFollowers: Math.max(0, input.minFollowers ?? 0),
        })
        .returning();
      if (!run) throw new Error("لم يُنشأ التشغيل");
      await db
        .insert(engineQueue)
        .values(seeds.map((username) => ({ runId: run.id, username, depth: 0, priority: 100 })))
        .onConflictDoNothing();
      await log(run.id, "start", `بدأ «${run.name}» من ${seeds.length} حساب.`);
      return run;
    },

    async listEngineRuns(limit = 50) {
      return db.select().from(engineRuns).orderBy(desc(engineRuns.createdAt)).limit(limit);
    },

    async engineRun(id: string) {
      const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, id));
      if (!run) return null;
      const byStatus = await db
        .select({ status: engineQueue.status, n: sql<number>`count(*)::int` })
        .from(engineQueue)
        .where(eq(engineQueue.runId, id))
        .groupBy(engineQueue.status);
      const next = await db
        .select({
          username: engineQueue.username,
          priority: engineQueue.priority,
          depth: engineQueue.depth,
          referrer: engineQueue.referrer,
        })
        .from(engineQueue)
        .where(and(eq(engineQueue.runId, id), eq(engineQueue.status, "queued")))
        .orderBy(desc(engineQueue.priority), asc(engineQueue.depth))
        .limit(15);
      return {
        run,
        queue: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])) as Record<
          string,
          number
        >,
        next,
      };
    },

    /** The accounts a run has read (newest first), like an Apify dataset. */
    async engineDataset(runId: string, opts: { acceptedOnly?: boolean; limit?: number } = {}) {
      return db
        .select({
          username: engineQueue.username,
          accepted: engineQueue.accepted,
          note: engineQueue.note,
          depth: engineQueue.depth,
          referrer: engineQueue.referrer,
          readAt: engineQueue.readAt,
          followers: engineQueue.followers,
          fullName: profiles.fullName,
          bio: profiles.bio,
          category: profiles.category,
          isBusiness: profiles.isBusiness,
          businessEmail: profiles.businessEmail,
          externalUrl: profiles.externalUrl,
        })
        .from(engineQueue)
        .leftJoin(profiles, eq(profiles.username, engineQueue.username))
        .where(
          and(
            eq(engineQueue.runId, runId),
            eq(engineQueue.status, "done"),
            ...(opts.acceptedOnly ? [eq(engineQueue.accepted, true)] : []),
          ),
        )
        .orderBy(desc(engineQueue.readAt))
        .limit(Math.min(opts.limit ?? 200, 50_000));
    },

    async engineEvents(limit = 30, runId?: string) {
      return db
        .select()
        .from(engineEvents)
        .where(runId ? eq(engineEvents.runId, runId) : undefined)
        .orderBy(desc(engineEvents.at))
        .limit(limit);
    },

    async setEngineRunStatus(id: string, status: "active" | "paused" | "stopped") {
      const [run] = await db
        .update(engineRuns)
        .set({ status, ...(status === "stopped" ? { finishedAt: new Date() } : {}) })
        .where(and(eq(engineRuns.id, id), inArray(engineRuns.status, ["active", "paused"])))
        .returning();
      if (run && status === "stopped") await sendAccepted(id, true);
      if (run)
        await log(
          id,
          status,
          status === "active" ? "استُؤنف." : status === "paused" ? "أُوقف مؤقتاً." : "أُنهي.",
        );
      return run ?? null;
    },

    /** The home worker asks what to read next (also its heartbeat). */
    engineNext: next,

    /** The home worker reports one account; the answer is what to do next. */
    async engineReport(r: EngineReport, now = new Date()) {
      await report(r, now);
      return next(now);
    },
  };
}
