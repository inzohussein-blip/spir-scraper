import type { RawProfile } from "../types.js";

export interface ProfileQuality {
  /** Average (likes + comments) per post as a percentage of followers, or null without data. */
  engagementRate: number | null;
  /** Heuristic warnings; none of them proves an account is fake. */
  flags: string[];
}

/**
 * Engagement and simple fake-account signals, in the spirit of tools like
 * Modash and IGLeads: low engagement for the audience size, follow-for-follow
 * patterns, and nearly empty accounts.
 */
export function profileQuality(
  p: Pick<RawProfile, "followers" | "following" | "posts" | "recentPosts">,
): ProfileQuality {
  const flags: string[] = [];
  const followers = p.followers ?? 0;
  const posts = (p.recentPosts ?? []).filter((x) => x.likes !== null || x.comments !== null);
  let engagementRate: number | null = null;
  if (posts.length >= 3 && followers > 0) {
    const avg = posts.reduce((s, x) => s + (x.likes ?? 0) + (x.comments ?? 0), 0) / posts.length;
    engagementRate = Math.round((avg / followers) * 100_000) / 1000;
    if (followers >= 5000 && engagementRate < 0.3) flags.push("low_engagement");
    if (followers >= 1000 && engagementRate > 40) flags.push("suspicious_engagement");
  }
  if ((p.following ?? 0) >= 1000 && (p.following ?? 0) > followers * 2)
    flags.push("follow_farming");
  if (p.posts !== null && p.posts !== undefined && p.posts < 3) flags.push("few_posts");
  return { engagementRate, flags };
}
