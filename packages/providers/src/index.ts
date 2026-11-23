import type { Connector, Provider } from "@scrapers/core";
import { ApifyProvider } from "./apify.js";
import { TelegramConnector } from "./connectors/telegram.js";
import { WebsiteConnector } from "./connectors/website.js";
import { YouTubeConnector } from "./connectors/youtube.js";
import { GraphProvider } from "./graph.js";
import { WorkerProvider } from "./worker.js";

export * from "./apify.js";
export * from "./connectors/telegram.js";
export * from "./connectors/website.js";
export * from "./connectors/youtube.js";
export * from "./graph.js";
export * from "./http.js";
export * from "./web/html.js";
export * from "./web/safe-fetch.js";
export * from "./web/site.js";
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

/**
 * Readers for other platforms, through official interfaces only:
 * YouTube Data API (YOUTUBE_API_KEY) and the Telegram Bot API (TELEGRAM_BOT_TOKEN).
 */
export function connectorsFromEnv(env: NodeJS.ProcessEnv = process.env): Connector[] {
  const list: Connector[] = [];
  if (env.YOUTUBE_API_KEY) list.push(new YouTubeConnector(env.YOUTUBE_API_KEY));
  if (env.TELEGRAM_BOT_TOKEN) list.push(new TelegramConnector(env.TELEGRAM_BOT_TOKEN));
  // Public websites need no key; turn off with WEBSITE_READER=off.
  if (env.WEBSITE_READER !== "off") list.push(new WebsiteConnector());
  return list;
}
