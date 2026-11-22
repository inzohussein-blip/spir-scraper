import type { Provider } from "@scrapers/core";
import { ApifyProvider } from "./apify.js";
import { GraphProvider } from "./graph.js";
import { WorkerProvider } from "./worker.js";

export * from "./apify.js";
export * from "./graph.js";
export * from "./http.js";
export * from "./worker.js";

/**
 * Builds the provider list from environment variables, in routing order:
 * the free Instaloader worker first (it sees contact buttons), then the
 * official Graph API when a business/creator account is configured, then
 * Apify within its credit.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const list: Provider[] = [];
  if (env.WORKER_URL) {
    list.push(
      new WorkerProvider({
        url: env.WORKER_URL,
        sharedSecret: env.WORKER_SHARED_SECRET ?? "",
        ...(env.WORKER_RATE_PER_MINUTE
          ? { ratePerMinute: Number(env.WORKER_RATE_PER_MINUTE) }
          : {}),
      }),
    );
  }
  if (env.IG_BUSINESS_ACCOUNT_ID && env.IG_GRAPH_TOKEN) {
    list.push(
      new GraphProvider({
        igUserId: env.IG_BUSINESS_ACCOUNT_ID,
        accessToken: env.IG_GRAPH_TOKEN,
        ...(env.META_GRAPH_VERSION ? { version: env.META_GRAPH_VERSION } : {}),
      }),
    );
  }
  if (env.APIFY_TOKEN) {
    list.push(
      new ApifyProvider({
        token: env.APIFY_TOKEN,
        monthlyCapUsd: Number(env.APIFY_MONTHLY_CAP_USD ?? 0),
        ...(env.APIFY_RECENT_POSTS ? { recentPosts: Number(env.APIFY_RECENT_POSTS) } : {}),
        ...(env.APIFY_FOLLOWERS_ACTOR ? { actors: { followers: env.APIFY_FOLLOWERS_ACTOR } } : {}),
      }),
    );
  }
  return list;
}
