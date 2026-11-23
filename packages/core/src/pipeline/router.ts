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
  followers: "account_followers",
  post: "post_commenters",
  hashtag: "hashtag_posters",
  search: "keyword_search",
  location: "location_posters",
  similar: "similar_accounts",
};

export type ProviderHealthEvent =
  | {
      provider: ProviderId;
      status: "down";
      reason: "rate_limited" | "blocked" | "budget";
      message: string;
    }
  | { provider: ProviderId; status: "up" };

export interface RouterOptions {
  /** Called when a provider starts resting and when it works again. */
  onHealth?: (e: ProviderHealthEvent) => void;
  /** Random spread added to request spacing, 0..1 of the interval (default 0.3). */
  jitter?: number;
  random?: () => number;
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
  private readonly down = new Set<ProviderId>();
  private readonly onHealth: ((e: ProviderHealthEvent) => void) | undefined;
  private readonly jitter: number;
  private readonly random: () => number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly providers: readonly Provider[],
    opts: RouterOptions = {},
  ) {
    this.cooldownMs = opts.cooldownMs ?? 15 * 60_000;
    this.onHealth = opts.onHealth;
    this.jitter = opts.jitter ?? 0.3;
    this.random = opts.random ?? Math.random;
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
    // Up to 30% random jitter so requests are not perfectly regular (idea from instagrapi's delay_range).
    const base = 60_000 / Math.max(p.ratePerMinute, 1);
    const interval = base * (1 + this.jitter * this.random());
    const t = this.now();
    const slot = Math.max(this.nextSlot.get(p.id) ?? 0, t);
    this.nextSlot.set(p.id, slot + interval);
    if (slot > t) await this.sleep(slot - t);
  }

  private rest(p: Provider, err: unknown): boolean {
    const reason =
      err instanceof RateLimitedError
        ? "rate_limited"
        : err instanceof BlockedError
          ? "blocked"
          : err instanceof BudgetExceededError
            ? "budget"
            : null;
    if (!reason) return false;
    this.cooldownUntil.set(p.id, this.now() + this.cooldownMs);
    if (!this.down.has(p.id)) {
      this.down.add(p.id);
      this.onHealth?.({ provider: p.id, status: "down", reason, message: (err as Error).message });
    }
    return true;
  }

  private ok(p: Provider) {
    if (this.down.delete(p.id)) this.onHealth?.({ provider: p.id, status: "up" });
  }

  /** Cooldowns and down-state, to persist between serverless invocations. */
  snapshot(): Record<string, { until: number; down: boolean }> {
    const out: Record<string, { until: number; down: boolean }> = {};
    for (const p of this.providers) {
      const until = this.cooldownUntil.get(p.id) ?? 0;
      if (until > this.now() || this.down.has(p.id))
        out[p.id] = { until, down: this.down.has(p.id) };
    }
    return out;
  }

  /** Merges saved state: keeps the later cooldown of the two. */
  restore(state: Record<string, { until: number; down: boolean }> | null | undefined) {
    if (!state) return;
    for (const [id, s] of Object.entries(state)) {
      const pid = id as ProviderId;
      if (s.until > (this.cooldownUntil.get(pid) ?? 0)) this.cooldownUntil.set(pid, s.until);
      if (s.down) this.down.add(pid);
    }
  }

  /** True when providers exist for this capability but all of them are resting. */
  exhausted(cap: Capability = "profile"): boolean {
    return this.supports(cap) && this.available(cap).length === 0;
  }

  /** Milliseconds until the first resting provider for this capability is usable again. */
  nextAvailableIn(cap: Capability = "profile"): number {
    const t = this.now();
    const waits = this.providers
      .filter((p) => p.capabilities.has(cap))
      .map((p) => (this.cooldownUntil.get(p.id) ?? 0) - t);
    return Math.max(0, Math.min(...waits, this.cooldownMs));
  }

  supports(cap: Capability): boolean {
    return this.providers.some((p) => p.capabilities.has(cap));
  }

  async getProfile(username: string): Promise<{ profile: RawProfile; provider: ProviderId }> {
    const errors: string[] = [];
    for (const p of this.available("profile")) {
      await this.throttle(p);
      try {
        const profile = await p.getProfile(username);
        this.ok(p);
        return { profile, provider: p.id };
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

  /**
   * Reads many profiles at once when the first usable provider can (Apify:
   * one run for the whole batch). Providers are tried in their usual order
   * and the batch stops at the first one that reads one account at a time,
   * so a free provider placed first is never skipped in favour of a paid one.
   * `missing` lists accounts a successful batch did not return (private or
   * gone): they are not worth paying for again one by one.
   */
  async getProfiles(usernames: string[]): Promise<{
    profiles: Map<string, { profile: RawProfile; provider: ProviderId }>;
    missing: Set<string>;
  }> {
    const profiles = new Map<string, { profile: RawProfile; provider: ProviderId }>();
    const missing = new Set<string>();
    if (usernames.length < 2) return { profiles, missing };
    for (const p of this.available("profile")) {
      if (!p.getProfiles) break;
      await this.throttle(p);
      try {
        for (const profile of await p.getProfiles(usernames))
          profiles.set(profile.username.toLowerCase(), { profile, provider: p.id });
        this.ok(p);
        for (const u of usernames) if (!profiles.has(u)) missing.add(u);
        break;
      } catch (err) {
        this.rest(p, err);
      }
    }
    return { profiles, missing };
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
        this.ok(p);
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

  /**
   * Starts a background collection on the first usable provider that can run
   * one (null when none can: the caller then collects the usual way).
   */
  async startEngagers(
    source: Exclude<Source, { type: "upload" }>,
    limit: number,
    notifyUrl: string | null,
  ): Promise<{ runId: string; provider: ProviderId } | null> {
    const cap = SOURCE_CAPABILITY[source.type];
    for (const p of this.available(cap)) {
      if (!p.startEngagers) return null;
      await this.throttle(p);
      try {
        const started = await p.startEngagers(source, limit, notifyUrl);
        if (!started) return null;
        this.ok(p);
        return { runId: started.runId, provider: p.id };
      } catch (err) {
        this.rest(p, err);
      }
    }
    return null;
  }

  async collectEngagers(
    provider: ProviderId,
    runId: string,
    source: Exclude<Source, { type: "upload" }>,
    limit: number,
  ) {
    const p = this.providers.find((x) => x.id === provider);
    if (!p?.collectEngagers)
      return { status: "failed" as const, error: `${provider} cannot read background runs` };
    return p.collectEngagers(runId, source, limit);
  }

  /** Approximate USD cost of one result from this provider (0 when free or unknown). */
  unitCost(id: ProviderId): number {
    return (this.providers.find((p) => p.id === id)?.costPer1k ?? 0) / 1000;
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
