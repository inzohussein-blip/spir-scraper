import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "@scrapers/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fromPglite, PgBoss } from "pg-boss";
import { ProviderRouter } from "../src/pipeline/router.js";
import { createScrapers } from "../src/pipeline/service.js";
import {
  type Capability,
  NotFoundError,
  type Provider,
  type ProviderId,
  type RawProfile,
} from "../src/types.js";

const migrationsFolder = fileURLToPath(new URL("../../db/drizzle", import.meta.url));

export async function setup(providers: Provider[]) {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder });
  const boss = new PgBoss({
    db: fromPglite(pg),
    backend: "pglite",
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {});
  await boss.start();
  const router = new ProviderRouter(providers, { sleep: async () => {} });
  const scrapers = createScrapers({
    db,
    boss,
    router,
    config: { suppressionPepper: "test-pepper" },
  });
  await scrapers.init();
  return {
    pg,
    db,
    boss,
    router,
    scrapers,
    async close() {
      await boss.stop({ graceful: false, timeout: 1000 }).catch(() => {});
      await pg.close();
    },
  };
}

/** Builds a deterministic fake profile from a username. */
export function fakeProfile(username: string): RawProfile {
  const n = Number(username.replace(/\D/g, "")) || 0;
  const kind = n % 4;
  return {
    igUserId: `id-${username}`,
    username,
    fullName: `User ${n}`,
    isBusiness: kind !== 3,
    isVerified: false,
    followers: 100 + n,
    category: kind === 3 ? null : "Financial service",
    bio:
      kind === 0
        ? `🇸🇦 trading coach. whatsapp ٠٥٠${String(1000000 + n).slice(-7)}`
        : kind === 1
          ? `contact: ${username} [at] example-fx [dot] com`
          : kind === 2
            ? "no contact here"
            : `personal ${username}@gmail.com`,
  };
}

export class FakeProvider implements Provider {
  calls = 0;
  readonly capabilities: ReadonlySet<Capability>;
  constructor(
    readonly id: ProviderId,
    caps: Capability[],
    private readonly impl: {
      profile?: (u: string) => Promise<RawProfile> | RawProfile;
      engagers?: (limit: number) => string[];
    } = {},
    readonly ratePerMinute = 6000,
    readonly costPer1k?: number,
  ) {
    this.capabilities = new Set(caps);
  }
  async getProfile(username: string): Promise<RawProfile> {
    this.calls++;
    if (!this.impl.profile) throw new NotFoundError("no impl", this.id);
    return this.impl.profile(username);
  }
  async *listEngagers(_source: unknown, limit: number): AsyncIterable<string> {
    for (const u of this.impl.engagers?.(limit) ?? []) yield u;
  }
}
