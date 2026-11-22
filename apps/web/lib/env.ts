import "server-only";
import { databaseUrl } from "@scrapers/runtime";

/** Public origin of this deployment, used for OAuth metadata and self-calls. */
export function appOrigin(req?: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (req) return new URL(req.url).origin;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL)
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export function authSecret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32)
    throw new Error("AUTH_SECRET must be set to at least 32 characters (openssl rand -hex 32)");
  return new TextEncoder().encode(s);
}

export function integrationStatus() {
  return {
    database: !!databaseUrl(),
    worker: !!process.env.WORKER_URL,
    apify: !!process.env.APIFY_TOKEN,
    graph: !!(process.env.IG_BUSINESS_ACCOUNT_ID && process.env.IG_GRAPH_TOKEN),
    ai: !!process.env.ANTHROPIC_API_KEY,
    sheets: !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    cron: !!process.env.CRON_SECRET,
  };
}
