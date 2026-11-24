import { competitorSnapshots, jobs, monitors } from "@scrapers/db";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { analyzePosts, growthPercent } from "../../extract/index.js";
import type { Source } from "../../types.js";
import type { Core } from "../core.js";
import { QUEUES } from "../core.js";

import type { CoreSelf } from "./context.js";

/** Competitors (analysis, growth snapshots) and recurring monitors. */
export function competitorsMethods(core: Core, api: () => CoreSelf) {
  const { db, boss, router, config, scorer, loadRouterState, saveRouterState, notify, maxLimit } =
    core;

  return {
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
        const project = input.projectId ? await api().getProject(input.projectId) : null;
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
  };
}
