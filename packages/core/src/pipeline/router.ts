import {
  BlockedError,
  BudgetExceededError,
  type Capability,
  NotFoundError,
  type Provider,
  type ProviderId,
  RateLimitedError,
  type RawProfile,
  type Source,
} from "../types.js";

export class NoProviderError extends Error {
  override name = "NoProviderError";
}

const SOURCE_CAPABILITY: Record<Exclude<Source["type"], "upload">, Capability> = {
  profile: "account_engagers",
  post: "post_commenters",
  hashtag: "hashtag_posters",
};

export interface RouterOptions {
  /** How long a provider rests after a 429 or a block. */
  cooldownMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Picks a provider for each call: one that supports the capability, is not
 * cooling down and has budget left. Rate-limited or blocked providers rest
 * and the call moves to the next one; we never retry insistently.
 */
export class ProviderRouter {
  private readonly cooldownUntil = new Map<ProviderId, number>();
  private readonly nextSlot = new Map<ProviderId, number>();
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly providers: readonly Provider[],
    opts: RouterOptions = {},
  ) {
    this.cooldownMs = opts.cooldownMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private available(cap: Capability): Provider[] {
    const t = this.now();
    return this.providers.filter(
      (p) => p.capabilities.has(cap) && (this.cooldownUntil.get(p.id) ?? 0) <= t,
    );
  }

  /** Spaces calls to each provider according to its ratePerMinute. */
  private async throttle(p: Provider): Promise<void> {
    const interval = 60_000 / Math.max(p.ratePerMinute, 1);
    const t = this.now();
    const slot = Math.max(this.nextSlot.get(p.id) ?? 0, t);
    this.nextSlot.set(p.id, slot + interval);
    if (slot > t) await this.sleep(slot - t);
  }

  private rest(p: Provider, err: unknown): boolean {
    if (
      err instanceof RateLimitedError ||
      err instanceof BlockedError ||
      err instanceof BudgetExceededError
    ) {
      this.cooldownUntil.set(p.id, this.now() + this.cooldownMs);
      return true;
    }
    return false;
  }

  supports(cap: Capability): boolean {
    return this.providers.some((p) => p.capabilities.has(cap));
  }

  async getProfile(username: string): Promise<{ profile: RawProfile; provider: ProviderId }> {
    const errors: string[] = [];
    for (const p of this.available("profile")) {
      await this.throttle(p);
      try {
        return { profile: await p.getProfile(username), provider: p.id };
      } catch (err) {
        if (err instanceof NotFoundError) throw err;
        if (!this.rest(p, err)) errors.push(`${p.id}: ${(err as Error).message}`);
        else errors.push(`${p.id}: ${(err as Error).name}`);
      }
    }
    throw new NoProviderError(
      `No provider could fetch @${username}${errors.length ? ` (${errors.join("; ")})` : ""}`,
    );
  }

  async listEngagers(
    source: Exclude<Source, { type: "upload" }>,
    limit: number,
  ): Promise<{ usernames: string[]; provider: ProviderId }> {
    const cap = SOURCE_CAPABILITY[source.type];
    const errors: string[] = [];
    for (const p of this.available(cap)) {
      if (!p.listEngagers) continue;
      await this.throttle(p);
      try {
        const out = new Set<string>();
        for await (const u of p.listEngagers(source, limit)) {
          out.add(u.toLowerCase());
          if (out.size >= limit) break;
        }
        return { usernames: [...out], provider: p.id };
      } catch (err) {
        this.rest(p, err);
        errors.push(`${p.id}: ${(err as Error).message}`);
      }
    }
    const hint = this.supports(cap)
      ? errors.join("; ")
      : `no configured provider supports ${source.type} sources; set APIFY_TOKEN or upload a CSV of usernames`;
    throw new NoProviderError(`Discovery failed: ${hint}`);
  }

  /** Rough USD cost of a job, shown before it runs. */
  estimateCost(source: Source, limit: number): number {
    let usd = 0;
    if (source.type !== "upload") {
      const p = this.available(SOURCE_CAPABILITY[source.type])[0];
      usd += ((p?.costPer1k ?? 0) * limit) / 1000;
    }
    const enrich = this.available("profile")[0];
    usd += ((enrich?.costPer1k ?? 0) * limit) / 1000;
    return Math.round(usd * 100) / 100;
  }
}
