import { competitorSnapshots, leads, profileSnapshots, profiles } from "@scrapers/db";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { checkMessage } from "../../compliance.js";
import { growthPercent } from "../../extract/index.js";
import {
  type ContentPlan,
  MARKET_TOPICS,
  type MarketTopic,
  templateContentPlan,
} from "../../market.js";
import type { FeatureContext } from "./context.js";

/** The market index (competitors, rising accounts, topics) and the weekly content plan. */
export function marketMethods(ctx: FeatureContext) {
  const { db, scorer, notify, getValue, setValue, self } = ctx;

  /**
   * The market over the last 30 days: which watched competitors grow fastest,
   * which accounts in the owner's data are rising, and which topics new
   * leads talk about, month by month.
   */
  async function marketIndex(now = new Date(), days = 30) {
    const since = new Date(now.getTime() - days * 86_400_000);
    const comp = await db
      .select({
        username: competitorSnapshots.username,
        first: sql<
          number | null
        >`(array_agg(${competitorSnapshots.followers} order by ${competitorSnapshots.at}))[1]`,
        last: sql<
          number | null
        >`(array_agg(${competitorSnapshots.followers} order by ${competitorSnapshots.at} desc))[1]`,
        points: sql<number>`count(*)::int`,
      })
      .from(competitorSnapshots)
      .where(and(gte(competitorSnapshots.at, since), isNotNull(competitorSnapshots.followers)))
      .groupBy(competitorSnapshots.username);
    const competitors = comp
      .map((c) => ({
        username: c.username,
        followers: c.last === null ? null : Number(c.last),
        change: c.first === null || c.last === null ? null : Number(c.last) - Number(c.first),
        percent: Number(c.points) > 1 ? growthPercent(c.first, c.last) : null,
      }))
      .sort((a, b) => (b.percent ?? -1e9) - (a.percent ?? -1e9));

    const growthExpr = sql<number>`((array_agg(${profileSnapshots.followers} order by ${profileSnapshots.at} desc))[1] - (array_agg(${profileSnapshots.followers} order by ${profileSnapshots.at}))[1])::float / nullif((array_agg(${profileSnapshots.followers} order by ${profileSnapshots.at}))[1], 0)`;
    const risingRows = await db
      .select({
        profileId: profileSnapshots.profileId,
        first: sql<number>`(array_agg(${profileSnapshots.followers} order by ${profileSnapshots.at}))[1]`,
        last: sql<number>`(array_agg(${profileSnapshots.followers} order by ${profileSnapshots.at} desc))[1]`,
        growth: growthExpr,
      })
      .from(profileSnapshots)
      .where(and(gte(profileSnapshots.at, since), isNotNull(profileSnapshots.followers)))
      .groupBy(profileSnapshots.profileId)
      .having(
        sql`count(*) > 1 and (array_agg(${profileSnapshots.followers} order by ${profileSnapshots.at} desc))[1] >= 1000`,
      )
      .orderBy(sql`${growthExpr} desc nulls last`)
      .limit(10);
    const names = risingRows.length
      ? await db
          .select({ id: profiles.igUserId, username: profiles.username, bio: profiles.bio })
          .from(profiles)
          .where(
            inArray(
              profiles.igUserId,
              risingRows.map((r) => r.profileId),
            ),
          )
      : [];
    const rising = risingRows
      .filter((r) => Number(r.growth) > 0)
      .map((r) => {
        const p = names.find((n) => n.id === r.profileId);
        return {
          username: p?.username ?? r.profileId,
          followers: Number(r.last),
          percent: Math.round(Number(r.growth) * 1000) / 10,
        };
      });

    // Topics in the bios of leads found each month (last six months).
    const sixMonths = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
    const month = sql<string>`to_char(date_trunc('month', ${leads.createdAt}), 'YYYY-MM')`;
    const topicKeys = Object.keys(MARKET_TOPICS) as MarketTopic[];
    const counts = await db
      .select({
        month,
        total: sql<number>`count(*)::int`,
        ...Object.fromEntries(
          topicKeys.map((k) => [
            k,
            sql<number>`count(*) filter (where coalesce(${profiles.bio}, '') || ' ' || coalesce(${profiles.category}, '') ~* ${MARKET_TOPICS[k].pattern})::int`,
          ]),
        ),
      })
      .from(leads)
      .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
      .where(gte(leads.createdAt, sixMonths))
      .groupBy(month)
      .orderBy(month);
    const months = counts.map((c) => {
      const row = c as unknown as Record<string, number | string>;
      return {
        month: String(row.month),
        total: Number(row.total),
        topics: Object.fromEntries(
          topicKeys.map((k) => [
            k,
            Number(row.total) ? Math.round((Number(row[k]) / Number(row.total)) * 1000) / 10 : 0,
          ]),
        ) as Record<MarketTopic, number>,
      };
    });
    const lastM = months.at(-1);
    const prevM = months.at(-2);
    const topics = topicKeys
      .map((k) => ({
        key: k,
        label: MARKET_TOPICS[k].label,
        share: lastM?.topics[k] ?? 0,
        change: lastM && prevM ? Math.round((lastM.topics[k] - prevM.topics[k]) * 10) / 10 : null,
      }))
      .sort((a, b) => (b.change ?? 0) - (a.change ?? 0) || b.share - a.share);
    return { since, competitors, rising, months, topics };
  }

  return {
    marketIndex,

    /** The monthly market report in Arabic (sent once a month by the daily cron). */
    async monthlyMarketReport(now = new Date()) {
      const key = `market:report:${now.toISOString().slice(0, 7)}`;
      if (await getValue(key)) return null;
      const m = await marketIndex(now);
      const lines = [`📈 تقرير السوق الشهري (${now.toISOString().slice(0, 7)})`];
      const growing = m.competitors.filter((c) => c.percent !== null).slice(0, 5);
      if (growing.length)
        lines.push(
          "",
          "المنافسون الأسرع نمواً:",
          ...growing.map(
            (c) =>
              `• @${c.username}: ${c.change !== null && c.change > 0 ? "+" : ""}${(c.change ?? 0).toLocaleString("en")} (${c.percent}%)`,
          ),
        );
      if (m.rising.length)
        lines.push(
          "",
          "حسابات صاعدة في بياناتك:",
          ...m.rising
            .slice(0, 5)
            .map((r) => `• @${r.username}: ${r.percent}% (${r.followers.toLocaleString("en")})`),
        );
      const t = m.topics.filter((x) => x.share > 0).slice(0, 4);
      if (t.length)
        lines.push(
          "",
          "المواضيع في حسابات العملاء الجدد:",
          ...t.map(
            (x) =>
              `• ${x.label}: ${x.share}%${x.change !== null ? ` (${x.change > 0 ? "+" : ""}${x.change} عن الشهر السابق)` : ""}`,
          ),
        );
      if (lines.length === 1) lines.push("", "لا توجد بيانات كافية بعد: راقب منافسين واجمع عملاء.");
      const text = lines.join("\n");
      await setValue(key, true, 40 * 86_400_000);
      await notify({
        type: "system",
        level: "info",
        title: "تقرير السوق الشهري",
        body: text.slice(0, 1500),
        url: "/market",
        key,
      });
      return text;
    },

    /**
     * A week of content and three reel scripts from what brings money: the
     * owner's best posts, rising topics, fast-growing competitors and the
     * project's segments. Written by AI when a key is set; every script is
     * checked against financial promotion rules.
     */
    async contentPlan(projectId: string, now = new Date()) {
      const project = await self().getProject(projectId);
      if (!project) throw new Error("المشروع غير موجود");
      const posts = await self()
        .ownPostPerformance(projectId)
        .catch(() => []);
      const best = [...posts]
        .sort((a, b) => b.revenue - a.revenue || (b.intentComments ?? 0) - (a.intentComments ?? 0))
        .slice(0, 5)
        .map((p) => ({
          caption: (p.caption ?? "").slice(0, 300),
          type: p.type,
          interest: p.intentComments ?? 0,
          revenue: p.revenue,
        }));
      const market = await marketIndex(now);
      const input = {
        offer: project.aiCriteria ?? "",
        personas: (project.personas ?? []).map((p) => ({
          name: p.name,
          description: p.description,
        })),
        bestPosts: best,
        risingTopics: market.topics
          .filter((t) => t.share > 0)
          .slice(0, 3)
          .map((t) => ({ topic: t.label, change: t.change ?? 0 })),
        competitors: market.competitors
          .slice(0, 5)
          .map((c) => ({ username: c.username, percent: c.percent })),
      };
      let plan: ContentPlan | null = null;
      let byAi = false;
      if (scorer?.contentPlan) {
        try {
          plan = await scorer.contentPlan(input);
          byAi = true;
        } catch {
          plan = null;
        }
      }
      plan ??= templateContentPlan(input);
      const reels = plan.reels.map((r) => {
        const check = checkMessage(`${r.hook}\n${r.script}\n${r.cta}`);
        return { ...r, issues: check.issues.map((i) => i.message) };
      });
      const saved = { ...plan, reels, byAi, createdAt: now.toISOString(), projectId };
      await setValue(`content:plan:${projectId}`, saved, 30 * 86_400_000);
      return saved;
    },

    async savedContentPlan(projectId: string) {
      return getValue<
        Omit<ContentPlan, "reels"> & {
          reels: (ContentPlan["reels"][number] & { issues: string[] })[];
          byAi: boolean;
          createdAt: string;
        }
      >(`content:plan:${projectId}`);
    },
  };
}
