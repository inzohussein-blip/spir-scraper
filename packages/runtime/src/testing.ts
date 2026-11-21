import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Provider, RawProfile, Scorer } from "@scrapers/core";
import * as schema from "@scrapers/db";
import type { GoogleRequest } from "@scrapers/exporters";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fromPglite, PgBoss } from "pg-boss";
import { createRuntime, type Runtime } from "./index.js";

/** Folder with @scrapers/db's SQL migrations. */
export function migrationsFolder(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@scrapers/db/package.json")), "drizzle");
}

/** Deterministic fake profile: even numbers are businesses with a phone in the bio. */
export function fakeProfile(username: string): RawProfile {
  const n = Number(username.replace(/\D/g, "")) || 0;
  return {
    igUserId: `id-${username}`,
    username,
    fullName: `User ${n}`,
    isBusiness: n % 2 === 0,
    isVerified: false,
    followers: 1000 + n,
    bio:
      n % 2 === 0 ? `🇮🇶 واتساب ٠٧٧٠${String(1000000 + n).slice(-7)} | hi@shop${n}.com` : "personal",
  };
}

export const fakeWorker: Provider = {
  id: "worker",
  capabilities: new Set(["profile"]),
  ratePerMinute: 1_000_000,
  costPer1k: 0,
  getProfile: async (u) => fakeProfile(u),
};

export interface TestRuntime extends Runtime {
  pg: PGlite;
}

/** A complete runtime on an in-memory Postgres (PGlite) for tests. */
export async function createTestRuntime(
  opts: {
    providers?: Provider[];
    scorer?: Scorer;
    sheetsRequest?: GoogleRequest;
    owner?: string;
    env?: Record<string, string>;
    telegramFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  } = {},
): Promise<TestRuntime> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  const boss = new PgBoss({
    db: fromPglite(pg),
    backend: "pglite",
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {});
  await boss.start();
  const runtime = await createRuntime(
    { SUPPRESSION_PEPPER: "test", OWNER_EMAIL: opts.owner ?? "owner@example.com", ...opts.env },
    {
      db,
      boss,
      providers: opts.providers ?? [fakeWorker],
      scorer: opts.scorer ?? null,
      ...(opts.telegramFetch ? { telegramFetch: opts.telegramFetch } : {}),
      ...(opts.sheetsRequest
        ? { sheetsRequest: opts.sheetsRequest, sheetsEmail: "sa@test.iam" }
        : {}),
      onClose: async () => {
        await boss.stop({ graceful: false, timeout: 1000 }).catch(() => {});
        await pg.close();
      },
    },
  );
  return Object.assign(runtime, { pg });
}

/** Runs queued work until every job has finished. */
export async function settle(runtime: Runtime) {
  for (let i = 0; i < 100; i++) {
    const r = await runtime.scrapers.drain({ budgetMs: 10_000 });
    if (r.activeJobs === 0) return;
  }
  throw new Error("jobs did not finish");
}
