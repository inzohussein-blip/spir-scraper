import {
  BudgetExceededError,
  type Capability,
  type Provider,
  ProviderError,
  type RawProfile,
  type Source,
} from "@scrapers/core";
import { ensureOk, type FetchLike } from "./http.js";

/**
 * Actor IDs are configurable because public actors change. These defaults
 * are Apify's own Instagram actors; their input/output fields were written
 * from documentation and are mapped defensively. Verify with a small run.
 */
export const DEFAULT_ACTORS = {
  profile: "apify~instagram-profile-scraper",
  posts: "apify~instagram-post-scraper",
  comments: "apify~instagram-comment-scraper",
  hashtag: "apify~instagram-hashtag-scraper",
} as const;

export interface ApifyProviderOptions {
  token: string;
  /**
   * Total monthly spend ceiling in USD. 0 = the account's own limit, which on
   * Apify's free plan is the free monthly credit, so nothing is ever charged.
   */
  monthlyCapUsd?: number;
  actors?: Partial<typeof DEFAULT_ACTORS>;
  /** How many recent posts of a competitor to read commenters from. */
  recentPosts?: number;
  /** Approximate cost per 1000 results, used for estimates only. */
  costPer1k?: number;
  baseUrl?: string;
  fetch?: FetchLike;
}

type Item = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pick = (o: Item, ...keys: string[]) =>
  keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);

/** Maps an Apify profile item onto RawProfile, accepting the field names actors use. */
export function mapApifyProfile(o: Item): RawProfile {
  const username = str(pick(o, "username", "userName"));
  if (!username) throw new ProviderError("Apify item has no username", "apify");
  return {
    igUserId: String(pick(o, "id", "pk", "userId") ?? username),
    username: username.toLowerCase(),
    fullName: str(pick(o, "fullName", "full_name")),
    bio: str(pick(o, "biography", "bio")),
    followers: num(pick(o, "followersCount", "followers", "follower_count")),
    following: num(pick(o, "followsCount", "following", "following_count")),
    posts: num(pick(o, "postsCount", "mediaCount", "media_count")),
    isBusiness: pick(o, "isBusinessAccount", "is_business_account", "isBusiness") === true,
    isVerified: pick(o, "verified", "isVerified", "is_verified") === true,
    category: str(pick(o, "businessCategoryName", "category", "categoryName")),
    externalUrl: str(pick(o, "externalUrl", "external_url", "website")),
    businessEmail: str(pick(o, "businessEmail", "publicEmail", "public_email", "email")),
    businessPhone: str(
      pick(
        o,
        "businessPhoneNumber",
        "publicPhoneNumber",
        "public_phone_number",
        "contactPhoneNumber",
      ),
    ),
    businessPhoneCountryCode: str(pick(o, "publicPhoneCountryCode", "public_phone_country_code")),
  };
}

function usernamesFrom(items: Item[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const owner = it.owner as Item | undefined;
    const u = str(pick(it, "ownerUsername", "username")) ?? (owner ? str(owner.username) : null);
    if (u) out.push(u.toLowerCase());
  }
  return out;
}

/**
 * Apify provider. Runs actors synchronously and stops before going past the
 * account's free monthly credit (or the configured cap on top of it).
 */
export class ApifyProvider implements Provider {
  readonly id = "apify" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set([
    "profile",
    "business_contact",
    "post_commenters",
    "hashtag_posters",
    "account_engagers",
  ]);
  readonly ratePerMinute = 30;
  readonly costPer1k: number;
  private readonly fetch: FetchLike;
  private readonly actors: typeof DEFAULT_ACTORS;
  private readonly base: string;

  constructor(private readonly opts: ApifyProviderOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.actors = { ...DEFAULT_ACTORS, ...opts.actors };
    this.base = (opts.baseUrl ?? "https://api.apify.com/v2").replace(/\/$/, "");
    this.costPer1k = opts.costPer1k ?? 2.5;
  }

  private headers() {
    return { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" };
  }

  /** USD still allowed this month: the account limit (or a lower cap) minus usage. */
  async remainingBudgetUsd(): Promise<number> {
    const res = await ensureOk(
      await this.fetch(`${this.base}/users/me/limits`, { headers: this.headers() }),
      this.id,
      "apify limits",
    );
    const body = (await res.json()) as {
      data?: { limits?: { maxMonthlyUsageUsd?: number }; current?: { monthlyUsageUsd?: number } };
    };
    const limit = body.data?.limits?.maxMonthlyUsageUsd ?? 0;
    const used = body.data?.current?.monthlyUsageUsd ?? 0;
    const cap = this.opts.monthlyCapUsd ?? 0;
    const allowed = cap > 0 ? Math.min(limit, cap) : limit;
    return Math.max(0, allowed - used);
  }

  private async run(actor: string, input: object, maxItems: number): Promise<Item[]> {
    const remaining = await this.remainingBudgetUsd();
    if (remaining <= 0.01) throw new BudgetExceededError("Apify monthly credit used up", this.id);
    const qs = new URLSearchParams({
      maxItems: String(maxItems),
      maxTotalChargeUsd: remaining.toFixed(2),
      timeout: "300",
    });
    const res = await this.fetch(`${this.base}/acts/${actor}/run-sync-get-dataset-items?${qs}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(330_000),
    });
    if (res.status === 402) throw new BudgetExceededError("Apify: payment required", this.id);
    await ensureOk(res, this.id, `apify ${actor}`);
    const items = (await res.json()) as unknown;
    return Array.isArray(items) ? (items as Item[]).filter((i) => !i.error) : [];
  }

  async getProfile(username: string): Promise<RawProfile> {
    const [item] = await this.run(this.actors.profile, { usernames: [username] }, 1);
    if (!item) throw new ProviderError(`Apify returned no profile for @${username}`, this.id);
    return mapApifyProfile(item);
  }

  async *listEngagers(
    source: Exclude<Source, { type: "upload" }>,
    limit: number,
  ): AsyncIterable<string> {
    if (source.type === "hashtag") {
      yield* usernamesFrom(
        await this.run(this.actors.hashtag, { hashtags: [source.tag], resultsLimit: limit }, limit),
      );
      return;
    }
    let postUrls: string[];
    if (source.type === "post") {
      postUrls = [source.url];
    } else {
      const posts = await this.run(
        this.actors.posts,
        { username: [source.username], resultsLimit: this.opts.recentPosts ?? 5 },
        this.opts.recentPosts ?? 5,
      );
      postUrls = posts.map((p) => str(p.url)).filter((u): u is string => !!u);
    }
    if (postUrls.length === 0) return;
    const perPost = Math.ceil(limit / postUrls.length);
    const comments = await this.run(
      this.actors.comments,
      { directUrls: postUrls, resultsLimit: perPost },
      limit * 2,
    );
    const own = source.type === "profile" ? source.username : null;
    for (const u of usernamesFrom(comments)) if (u !== own) yield u;
  }
}
