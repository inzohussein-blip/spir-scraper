import { createScrapers, ProviderRouter, type Scrapers } from "@scrapers/core";
import { createDb } from "@scrapers/db";
import { providersFromEnv } from "@scrapers/providers";
import { PgBoss } from "pg-boss";

export interface Context {
  scrapers: Scrapers;
  /** Owner recorded on new projects. */
  owner: string;
  close(): Promise<void>;
}

export type ContextFactory = () => Promise<Context>;

/** Loads .env from the current directory if it exists (Node's built-in loader). */
export function loadEnv() {
  try {
    process.loadEnvFile();
  } catch {
    // No .env: rely on the real environment.
  }
}

export const productionContext: ContextFactory = async () => {
  const env = process.env;
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
  if (!env.SUPPRESSION_PEPPER)
    throw new Error("SUPPRESSION_PEPPER is not set (openssl rand -hex 32)");
  const db = createDb(env.DATABASE_URL);
  // pg-boss needs a session connection: Supabase's direct URL, not the transaction pooler.
  const boss = new PgBoss(env.DIRECT_DATABASE_URL ?? env.DATABASE_URL);
  boss.on("error", (err) => console.error("[pg-boss]", err.message));
  await boss.start();
  const providers = providersFromEnv(env);
  const scrapers = createScrapers({
    db,
    boss,
    router: new ProviderRouter(providers),
    config: {
      suppressionPepper: env.SUPPRESSION_PEPPER,
      maxJobLimit: Number(env.MAX_JOB_LIMIT ?? 1000),
      defaultRetentionDays: Number(env.DEFAULT_RETENTION_DAYS ?? 90),
    },
  });
  await scrapers.init();
  return {
    scrapers,
    owner: env.OWNER_EMAIL || "owner",
    async close() {
      await boss.stop({ graceful: true, timeout: 10_000 });
      await db.$client.end();
    },
  };
};
