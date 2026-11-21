import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}) {
  if (!url) throw new Error("DATABASE_URL is not set");
  // prepare: false keeps the client compatible with Supabase's transaction pooler.
  const client = postgres(url, { prepare: false, max: opts.max ?? 10 });
  return Object.assign(drizzle(client, { schema }), { $client: client });
}

export type Db = ReturnType<typeof createDb>;

/** Any Drizzle Postgres database with this schema (postgres.js in production, PGlite in tests). */
export type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
