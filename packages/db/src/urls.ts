type Env = Record<string, string | undefined>;

const first = (...values: (string | undefined)[]) => values.find((v) => v?.trim())?.trim();

/**
 * Pooled URL for ordinary queries. Accepts our own name or the one Vercel's
 * Postgres integrations set (Neon and Supabase both provide POSTGRES_URL).
 */
export function databaseUrl(env: Env = process.env): string | undefined {
  return first(env.DATABASE_URL, env.POSTGRES_URL);
}

/**
 * Direct (session) URL for the job queue and migrations, which cannot run
 * through a transaction pooler. Falls back to the names Vercel's integrations
 * set: DATABASE_URL_UNPOOLED (Neon) and POSTGRES_URL_NON_POOLING (Supabase),
 * then to the pooled URL.
 */
export function directDatabaseUrl(env: Env = process.env): string | undefined {
  return first(
    env.DIRECT_DATABASE_URL,
    env.DATABASE_URL_UNPOOLED,
    env.POSTGRES_URL_NON_POOLING,
    databaseUrl(env),
  );
}
