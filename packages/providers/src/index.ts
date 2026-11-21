import type { Provider } from "@scrapers/core";
import { ApifyProvider } from "./apify.js";
import { WorkerProvider } from "./worker.js";

export * from "./apify.js";
export * from "./http.js";
export * from "./worker.js";

/**
 * Builds the provider list from environment variables, in routing order:
 * the free Instaloader worker first, Apify (free credit) as the fallback.
 * The Graph API provider is added once a business/creator account exists.
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
  if (env.APIFY_TOKEN) {
    list.push(
      new ApifyProvider({
        token: env.APIFY_TOKEN,
        monthlyCapUsd: Number(env.APIFY_MONTHLY_CAP_USD ?? 0),
      }),
    );
  }
  return list;
}
