import type { Capability, Provider, RawProfile } from "@scrapers/core";
import { ensureOk, type FetchLike } from "./http.js";

export interface WorkerProviderOptions {
  url: string;
  sharedSecret: string;
  /** Requests per minute. Kept low on purpose: no login, one IP. */
  ratePerMinute?: number;
  timeoutMs?: number;
  fetch?: FetchLike;
}

/**
 * Talks to services/ig-worker, the internal Python service that wraps
 * Instaloader for public profiles without logging in.
 */
export class WorkerProvider implements Provider {
  readonly id = "worker" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set(["profile", "business_contact"]);
  readonly ratePerMinute: number;
  readonly costPer1k = 0;
  private readonly fetch: FetchLike;

  constructor(private readonly opts: WorkerProviderOptions) {
    this.ratePerMinute = opts.ratePerMinute ?? 20;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async getProfile(username: string): Promise<RawProfile> {
    const res = await this.fetch(
      `${this.opts.url.replace(/\/$/, "")}/profile/${encodeURIComponent(username)}`,
      {
        headers: { "x-worker-secret": this.opts.sharedSecret },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      },
    );
    await ensureOk(res, this.id, `worker profile @${username}`);
    return (await res.json()) as RawProfile;
  }
}
