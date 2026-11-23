import type { RecentPost } from "../types.js";

export interface PostAnalysis {
  /** Posts with likes or comments. */
  analysed: number;
  /** Average likes + comments per post. */
  avgInteractions: number | null;
  /** Average interactions as a percentage of followers. */
  engagementRate: number | null;
  /** Average interactions by content type (image, video, carousel). */
  byType: { type: string; posts: number; avg: number }[];
  /** Local hours (0-23) of the best-performing posts, best first. */
  bestHours: number[];
  /** Local weekdays (0 = Sunday) of the best-performing posts, best first. */
  bestDays: number[];
  /** Hashtags used most often. */
  topHashtags: { tag: string; count: number }[];
  /** Posts with the most interactions. */
  topPosts: { url: string | null; interactions: number; caption: string | null }[];
  /** Average days between posts. */
  postEveryDays: number | null;
}

const interactions = (p: RecentPost) => (p.likes ?? 0) + (p.comments ?? 0);

function rankBy<K>(posts: RecentPost[], key: (p: RecentPost) => K | null): K[] {
  const sums = new Map<K, { total: number; n: number }>();
  for (const p of posts) {
    const k = key(p);
    if (k === null) continue;
    const cur = sums.get(k) ?? { total: 0, n: 0 };
    cur.total += interactions(p);
    cur.n++;
    sums.set(k, cur);
  }
  return [...sums.entries()]
    .sort((a, b) => b[1].total / b[1].n - a[1].total / a[1].n)
    .map(([k]) => k);
}

function localParts(iso: string, timeZone: string): { hour: number; day: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.find((p) => p.type === "weekday")?.value ?? "",
  );
  return Number.isFinite(hour) && day >= 0 ? { hour, day } : null;
}

/** What works on a competitor's account, from its recent public posts. */
export function analyzePosts(
  recent: RecentPost[] | null | undefined,
  followers: number | null | undefined,
  timeZone = "Asia/Baghdad",
): PostAnalysis {
  const posts = (recent ?? []).filter((p) => p.likes !== null || p.comments !== null);
  const total = posts.reduce((s, p) => s + interactions(p), 0);
  const avg = posts.length ? total / posts.length : null;

  const types = new Map<string, { n: number; total: number }>();
  for (const p of posts) {
    if (!p.type) continue;
    const cur = types.get(p.type) ?? { n: 0, total: 0 };
    cur.n++;
    cur.total += interactions(p);
    types.set(p.type, cur);
  }

  const tags = new Map<string, number>();
  for (const p of posts) {
    for (const m of (p.caption ?? "").matchAll(/#([\p{L}\p{N}_]+)/gu)) {
      const t = (m[1] as string).toLowerCase();
      tags.set(t, (tags.get(t) ?? 0) + 1);
    }
  }

  const times = posts
    .map((p) => (p.timestamp ? new Date(p.timestamp).getTime() : Number.NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a);
  const span =
    times.length >= 2 ? ((times[0] as number) - (times.at(-1) as number)) / 86_400_000 : null;

  return {
    analysed: posts.length,
    avgInteractions: avg === null ? null : Math.round(avg),
    engagementRate:
      avg !== null && followers ? Math.round((avg / followers) * 100_000) / 1000 : null,
    byType: [...types.entries()]
      .map(([type, v]) => ({ type, posts: v.n, avg: Math.round(v.total / v.n) }))
      .sort((a, b) => b.avg - a.avg),
    bestHours: rankBy(posts, (p) =>
      p.timestamp ? (localParts(p.timestamp, timeZone)?.hour ?? null) : null,
    ).slice(0, 3),
    bestDays: rankBy(posts, (p) =>
      p.timestamp ? (localParts(p.timestamp, timeZone)?.day ?? null) : null,
    ).slice(0, 3),
    topHashtags: [...tags.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count })),
    topPosts: [...posts]
      .sort((a, b) => interactions(b) - interactions(a))
      .slice(0, 3)
      .map((p) => ({
        url: p.url ?? null,
        interactions: interactions(p),
        caption: p.caption ? p.caption.slice(0, 160) : null,
      })),
    postEveryDays:
      span !== null && times.length > 1 ? Math.round((span / (times.length - 1)) * 10) / 10 : null,
  };
}

/** Percent change in followers between two snapshots, or null. */
export function growthPercent(before: number | null, after: number | null): number | null {
  if (!before || after === null) return null;
  return Math.round(((after - before) / before) * 1000) / 10;
}
