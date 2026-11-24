import { leads, profiles, usageDaily, usageSlots } from "@scrapers/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { FeatureContext } from "./context.js";

/** Where a request came from, for the «الاستهلاك» page. */
export type UsageCategory =
  | "dashboard"
  | "engine"
  | "telegram"
  | "cron"
  | "queue"
  | "api"
  | "mcp"
  | "webhooks"
  | "public";

export const USAGE_LABELS: Record<UsageCategory, string> = {
  dashboard: "اللوحة",
  engine: "محرك Spir",
  telegram: "تلكرام",
  cron: "الصيانة اليومية",
  queue: "معالجة المهام",
  api: "الإضافة والـ API",
  mcp: "Claude (MCP)",
  webhooks: "الوسيط و Meta و Apify",
  public: "روابط الوكلاء",
};

/**
 * The free-plan limits the page compares against. Plans change: the owner
 * can correct each number on the page.
 */
export interface UsageLimits {
  /** Database awake hours a month. */
  dbHours: number;
  /** Database storage, in MB. */
  dbStorageMb: number;
  /** Platform requests (function calls) a month. */
  requests: number;
  /** Apify credit a month, USD (read from Apify when connected). */
  apifyUsd: number;
}

export const DEFAULT_USAGE_LIMITS: UsageLimits = {
  dbHours: 190,
  dbStorageMb: 512,
  requests: 1_000_000,
  apifyUsd: 5,
};

const LIMITS_KEY = "usage:limits";
const SLOT_MS = 5 * 60_000;

/** Awake minutes from the active 5-minute slots: each wake keeps the database up about one more slot. */
export function awakeMinutes(slots: number[]): number {
  const on = new Set(slots);
  let n = 0;
  for (let s = 0; s < 288; s++) if (on.has(s) || on.has(s - 1)) n++;
  return n * 5;
}

/** How far into the month (UTC) we are, 0..1. */
export function monthFraction(now: Date): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1 / 1440, (now.getTime() - start) / (end - start));
}

export function usageMethods(ctx: FeatureContext) {
  const { db, getValue, setValue } = ctx;

  /** Raw SQL rows, whichever driver runs (postgres.js returns an array, PGlite { rows }). */
  async function query<T>(q: ReturnType<typeof sql>): Promise<T[]> {
    const out = (await db.execute(q)) as unknown;
    return (Array.isArray(out) ? out : ((out as { rows?: unknown[] }).rows ?? [])) as T[];
  }

  return {
    /**
     * Counts one request of this kind and marks its 5-minute slot. Called
     * from requests that touch the database anyway, so it wakes nothing.
     */
    async recordUsage(category: UsageCategory, now = new Date()) {
      const day = now.toISOString().slice(0, 10);
      const slot = Math.floor((now.getTime() % 86_400_000) / SLOT_MS);
      await db
        .insert(usageDaily)
        .values({ day, category, requests: 1 })
        .onConflictDoUpdate({
          target: [usageDaily.day, usageDaily.category],
          set: { requests: sql`${usageDaily.requests} + 1` },
        });
      await db.insert(usageSlots).values({ day, slot }).onConflictDoNothing();
    },

    async usageLimits(): Promise<UsageLimits> {
      return {
        ...DEFAULT_USAGE_LIMITS,
        ...((await getValue<Partial<UsageLimits>>(LIMITS_KEY)) ?? {}),
      };
    },

    async saveUsageLimits(input: Partial<UsageLimits>) {
      const cur = {
        ...DEFAULT_USAGE_LIMITS,
        ...((await getValue<Partial<UsageLimits>>(LIMITS_KEY)) ?? {}),
      };
      const next = { ...cur, ...input };
      for (const k of Object.keys(next) as (keyof UsageLimits)[])
        if (!Number.isFinite(next[k]) || next[k] <= 0) next[k] = DEFAULT_USAGE_LIMITS[k];
      await setValue(LIMITS_KEY, next, 10 * 365 * 86_400_000);
      return next;
    },

    /**
     * This month so far: requests by kind and by day, the database's
     * estimated awake hours, its storage (exact) and the biggest tables.
     */
    async usageReport(now = new Date()) {
      const monthStart = `${now.toISOString().slice(0, 7)}-01`;
      const byCategory = await db
        .select({
          category: usageDaily.category,
          requests: sql<number>`sum(${usageDaily.requests})::int`,
        })
        .from(usageDaily)
        .where(gte(usageDaily.day, monthStart))
        .groupBy(usageDaily.category)
        .orderBy(desc(sql`sum(${usageDaily.requests})`));
      const byDayRows = await db
        .select({ day: usageDaily.day, requests: sql<number>`sum(${usageDaily.requests})::int` })
        .from(usageDaily)
        .where(gte(usageDaily.day, monthStart))
        .groupBy(usageDaily.day)
        .orderBy(usageDaily.day);
      const slotRows = await db
        .select({ day: usageSlots.day, slot: usageSlots.slot })
        .from(usageSlots)
        .where(gte(usageSlots.day, monthStart));
      const slotsByDay = new Map<string, number[]>();
      for (const r of slotRows)
        slotsByDay.set(String(r.day), [...(slotsByDay.get(String(r.day)) ?? []), r.slot]);
      const days = byDayRows.map((d) => ({
        day: String(d.day),
        requests: Number(d.requests),
        awakeMinutes: awakeMinutes(slotsByDay.get(String(d.day)) ?? []),
      }));
      const [size] = await query<{ bytes: string | number }>(
        sql`select pg_database_size(current_database())::bigint as bytes`,
      );
      const tables = await query<{ name: string; bytes: string | number }>(
        sql`select c.relname as name, pg_total_relation_size(c.oid)::bigint as bytes
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
            order by pg_total_relation_size(c.oid) desc limit 8`,
      );
      const requests = byCategory.reduce((a, c) => a + Number(c.requests), 0);
      const dbHours = days.reduce((a, d) => a + d.awakeMinutes, 0) / 60;
      const f = monthFraction(now);
      return {
        monthStart,
        fraction: f,
        requests,
        byCategory: byCategory.map((c) => ({
          category: c.category as UsageCategory,
          requests: Number(c.requests),
        })),
        days,
        dbHours,
        storageBytes: Number(size?.bytes ?? 0),
        tables: tables.map((t) => ({ name: t.name, bytes: Number(t.bytes) })),
        forecast: { requests: requests / f, dbHours: dbHours / f },
      };
    },

    /** username → status and score, for the extension's badge (fetched once a day, then looked up locally). */
    async leadIndex(projectId: string) {
      const rows = await db
        .select({ username: profiles.username, status: leads.status, aiScore: leads.aiScore })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(and(eq(leads.projectId, projectId)));
      return rows.map((r) => [r.username, r.status, r.aiScore] as const);
    },
  };
}
