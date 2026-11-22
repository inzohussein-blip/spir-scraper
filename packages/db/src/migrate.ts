import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { directDatabaseUrl } from "./urls.js";

export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * With --if-configured (used by the Vercel build), a missing database URL or a
 * non-production Vercel build is a skip, not a failure, so the first deploy
 * works before the database is connected and previews never touch it.
 */
export function skipReason(
  args: readonly string[],
  env: Record<string, string | undefined>,
): string | null {
  if (!args.includes("--if-configured")) return null;
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "production")
    return `VERCEL_ENV is ${env.VERCEL_ENV}, migrations run on production builds only`;
  if (!directDatabaseUrl(env)) return "no database URL is set yet";
  return null;
}

async function main() {
  const skip = skipReason(process.argv.slice(2), process.env);
  if (skip) {
    console.log(`migrations skipped: ${skip}`);
    return;
  }
  const url = directDatabaseUrl();
  if (!url)
    throw new Error(
      "Set DIRECT_DATABASE_URL (or DATABASE_URL_UNPOOLED / DATABASE_URL, also with a NEON_ prefix)",
    );
  const client = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
    console.log("migrations applied");
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
