type Env = Record<string, string | undefined>;

const first = (...values: (string | undefined)[]) => values.find((v) => v?.trim())?.trim();

/**
 * Vercel's storage integrations can add a custom prefix to the names they set
 * (for example NEON_DATABASE_URL). NEON_ and STORAGE_ are read as well, and
 * DATABASE_ENV_PREFIX names any other prefix chosen when connecting.
 */
function prefixed(env: Env, name: string): (string | undefined)[] {
  const custom = env.DATABASE_ENV_PREFIX?.trim();
  const prefixes = [custom, "NEON", "STORAGE"].filter((p): p is string => !!p);
  return prefixes.map((p) => env[`${p.replace(/_+$/, "")}_${name}`]);
}

/**
 * Pooled URL for ordinary queries. Accepts our own name or the one Vercel's
 * Postgres integrations set (Neon and Supabase both provide POSTGRES_URL).
 */
export function databaseUrl(env: Env = process.env): string | undefined {
  return first(
    env.DATABASE_URL,
    env.POSTGRES_URL,
    ...prefixed(env, "DATABASE_URL"),
    ...prefixed(env, "POSTGRES_URL"),
  );
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
    ...prefixed(env, "DATABASE_URL_UNPOOLED"),
    ...prefixed(env, "POSTGRES_URL_NON_POOLING"),
    databaseUrl(env),
  );
}

/** Neon AWS regions and the Vercel function region closest to each. */
const NEON_TO_VERCEL: Record<string, string> = {
  "us-east-1": "iad1",
  "us-east-2": "cle1",
  "us-west-2": "pdx1",
  "ca-central-1": "yul1",
  "sa-east-1": "gru1",
  "eu-central-1": "fra1",
  "eu-west-1": "dub1",
  "eu-west-2": "lhr1",
  "eu-west-3": "cdg1",
  "eu-north-1": "arn1",
  "ap-south-1": "bom1",
  "ap-southeast-1": "sin1",
  "ap-southeast-2": "syd1",
  "ap-northeast-1": "hnd1",
  "ap-northeast-2": "icn1",
};

/**
 * The database's region read from its host name, and the Vercel region next
 * to it. Neon hosts look like ep-name-123.eu-central-1.aws.neon.tech.
 */
export function databaseRegion(url: string | undefined): {
  host: string | null;
  region: string | null;
  vercelRegion: string | null;
} {
  let host: string | null = null;
  try {
    host = url ? new URL(url).hostname : null;
  } catch {
    host = null;
  }
  const region = host
    ? (/^[^.]+\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host)?.[1] ?? null)
    : null;
  return { host, region, vercelRegion: region ? (NEON_TO_VERCEL[region] ?? null) : null };
}
