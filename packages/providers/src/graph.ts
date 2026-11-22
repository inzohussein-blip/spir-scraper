import {
  BlockedError,
  type Capability,
  type Provider,
  ProviderError,
  RateLimitedError,
  type RawProfile,
} from "@scrapers/core";
import type { FetchLike } from "./http.js";

export interface GraphProviderOptions {
  /** Instagram user id of YOUR business or creator account. */
  igUserId: string;
  /** Long-lived access token with instagram_basic and pages_read_engagement. */
  accessToken: string;
  /** Graph API version; check Meta's changelog for the current one. */
  version?: string;
  fetch?: FetchLike;
}

type GraphError = { error?: { code?: number; error_subcode?: number; message?: string } };

const RATE_CODES = new Set([4, 17, 32, 613, 80002]);
const TOKEN_CODES = new Set([102, 190, 200, 10]);

/**
 * Official Instagram Graph API (Business Discovery). Free and sanctioned,
 * but it only sees business and creator accounts and exposes no contact
 * button fields, so it is a fallback for profiles, not a contact source.
 */
export class GraphProvider implements Provider {
  readonly id = "graph" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set(["profile"]);
  readonly ratePerMinute = 60;
  readonly costPer1k = 0;
  private readonly fetch: FetchLike;

  constructor(private readonly opts: GraphProviderOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async getProfile(username: string): Promise<RawProfile> {
    const fields = `business_discovery.username(${username}){id,username,name,biography,followers_count,follows_count,media_count,website}`;
    const url = new URL(
      `https://graph.facebook.com/${this.opts.version ?? "v23.0"}/${this.opts.igUserId}`,
    );
    url.searchParams.set("fields", fields);
    url.searchParams.set("access_token", this.opts.accessToken);
    const res = await this.fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => ({}))) as GraphError & {
      business_discovery?: {
        id: string;
        username: string;
        name?: string;
        biography?: string;
        followers_count?: number;
        follows_count?: number;
        media_count?: number;
        website?: string;
      };
    };
    const code = body.error?.code;
    if (code !== undefined || !res.ok) {
      const msg = `graph @${username}: ${body.error?.message ?? `HTTP ${res.status}`}`;
      if ((code !== undefined && RATE_CODES.has(code)) || res.status === 429)
        throw new RateLimitedError(msg, this.id);
      if (code !== undefined && TOKEN_CODES.has(code)) throw new BlockedError(msg, this.id);
      // Personal or missing accounts are invisible to Business Discovery: let other providers try.
      throw new ProviderError(msg, this.id);
    }
    const d = body.business_discovery;
    if (!d) throw new ProviderError(`graph @${username}: empty response`, this.id);
    return {
      igUserId: d.id,
      username: d.username.toLowerCase(),
      fullName: d.name ?? null,
      bio: d.biography ?? null,
      followers: d.followers_count ?? null,
      following: d.follows_count ?? null,
      posts: d.media_count ?? null,
      // Business Discovery only returns business and creator accounts.
      isBusiness: true,
      isVerified: false,
      category: null,
      externalUrl: d.website ?? null,
    };
  }
}
