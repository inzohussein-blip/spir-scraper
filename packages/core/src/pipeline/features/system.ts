import { randomBytes } from "node:crypto";
import {
  apiKeys,
  auditLog,
  competitorSnapshots,
  jobs,
  leads,
  notifications,
  profiles,
  pushSubscriptions,
} from "@scrapers/db";
import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { growthPercent } from "../../extract/index.js";
import { redactSecrets } from "../../notify.js";
import type { Core } from "../core.js";
import { type ApiScope, hashKey } from "../core.js";

import type { CoreSelf } from "./context.js";

/** Notifications, audit log, API keys, browser push, health, overview and the weekly summary. */
export function systemMethods(core: Core, _api: () => CoreSelf) {
  const { db, router, config, getValue, claimOnce, notify } = core;

  return {
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
  };
}
