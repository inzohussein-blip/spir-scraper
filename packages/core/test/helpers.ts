import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "@scrapers/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fromPglite, PgBoss } from "pg-boss";
import { ProviderRouter } from "../src/pipeline/router.js";
import { createScrapers } from "../src/pipeline/service.js";
import type { LeadScore, Scorer, ScoringInput } from "../src/scoring.js";
import {
  type Capability,
  type Connector,
  type FollowingSource,
  NotFoundError,
  type PlacesSearch,
  type Provider,
  type ProviderId,
  type RawProfile,
} from "../src/types.js";

const migrationsFolder = fileURLToPath(new URL("../../db/drizzle", import.meta.url));

export async function setup(
  providers: Provider[],
  scorer?: Scorer,
  opts: {
    connectors?: Connector[];
    places?: PlacesSearch;
    readPage?: (url: string) => Promise<{ title: string | null; text: string }>;
    following?: FollowingSource;
  } = {},
) {
  const pg = new PGlite({ extensions: { pg_trgm } });
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
    scorer,
    // No network in tests: link-in-bio pages and MX checks are tested separately.
    resolve: {},
    config: { suppressionPepper: "test-pepper" },
    ...(opts.connectors ? { connectors: opts.connectors } : {}),
    ...(opts.places ? { places: opts.places } : {}),
    ...(opts.readPage ? { readPage: opts.readPage } : {}),
    ...(opts.following ? { following: opts.following } : {}),
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

/** A scorer that scores by follower count, with an in-memory "batch" API. */
export class FakeScorer implements Scorer {
  batches = new Map<string, { items: ScoringInput[]; ready: boolean }>();
  constructor(readonly batchThreshold = 100) {}
  private score(items: ScoringInput[]) {
    return new Map<string, LeadScore>(
      items.map((i) => [
        i.id,
        {
          segment: i.isBusiness ? "potential_partner" : "individual_trader",
          language: "ar",
          country: "SA",
          score: Math.min(100, Math.round((i.followers ?? 0) / 10)),
          reason: `followers ${i.followers}`,
        },
      ]),
    );
  }
  async scoreNow(items: ScoringInput[]) {
    return this.score(items);
  }
  async submitBatch(items: ScoringInput[]) {
    const id = `batch_${this.batches.size + 1}`;
    this.batches.set(id, { items, ready: false });
    return id;
  }
  async collectBatch(id: string) {
    const b = this.batches.get(id);
    return b?.ready ? this.score(b.items) : null;
  }
  async report(stats: { total: number }) {
    return `report for ${stats.total}`;
  }
}
