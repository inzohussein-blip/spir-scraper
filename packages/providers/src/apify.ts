import {
  AccountNotFoundError,
  BudgetExceededError,
  type Capability,
  type FollowingSource,
  type PlacesSearch,
  type Provider,
  ProviderError,
  type RawPlace,
  type RawProfile,
  type RecentPost,
  type RemoteAccount,
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
  /** Apify's own followers actor: no Instagram login of ours is involved. */
  followers: "apify~instagram-followers-following-scraper",
  /** Google Maps businesses (name, category, phone, website, rating). */
  places: "compass~crawler-google-places",
  /** TikTok profiles (author stats come with the latest video). */
  tiktok: "clockworks~tiktok-profile-scraper",
} as const;

/** Recent posts of a competitor whose commenters are collected (more posts, more people). */
export const DEFAULT_RECENT_POSTS = 20;

export interface ApifyProviderOptions {
  token: string;
  /**
   * Total monthly spend ceiling in USD. 0 = the account's own limit, which on
   * Apify's free plan is the free monthly credit, so nothing is ever charged.
   */
  monthlyCapUsd?: number;
  actors?: Partial<Record<keyof typeof DEFAULT_ACTORS, string>>;
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

const POST_TYPES: Record<string, string> = {
  image: "image",
  graphimage: "image",
  video: "video",
  graphvideo: "video",
  reel: "video",
  clips: "video",
  sidecar: "carousel",
  graphsidecar: "carousel",
  carousel: "carousel",
};

function recentPosts(v: unknown): RecentPost[] | null {
  if (!Array.isArray(v)) return null;
  return (v as Item[]).slice(0, 12).map((p) => {
    const kind = str(pick(p, "type", "productType", "__typename"))?.toLowerCase() ?? "";
    return {
      likes: num(pick(p, "likesCount", "likes_count", "likes")),
      comments: num(pick(p, "commentsCount", "comments_count", "comments")),
      caption: str(pick(p, "caption", "text"))?.slice(0, 500) ?? null,
      timestamp: str(pick(p, "timestamp", "taken_at", "takenAt")),
      type: POST_TYPES[kind] ?? null,
      url: str(pick(p, "url")),
    };
  });
}

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
    businessWhatsapp: str(pick(o, "whatsappNumber", "whatsapp_number", "businessWhatsappNumber")),
    city: str(pick(o, "cityName", "city_name", "city")),
    recentPosts: recentPosts(pick(o, "latestPosts", "latest_posts")),
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
export class ApifyProvider implements Provider, PlacesSearch, FollowingSource {
  readonly id = "apify" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set([
    "profile",
    "business_contact",
    "post_commenters",
    "hashtag_posters",
    "account_engagers",
    "account_followers",
  ]);
  readonly ratePerMinute = 30;
  readonly costPer1k: number;
  private readonly fetch: FetchLike;
  private readonly actors: Record<keyof typeof DEFAULT_ACTORS, string>;
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

  /** This month's spend and what is allowed: the account limit, or a lower cap. */
  async usage(): Promise<{ usedUsd: number; allowedUsd: number }> {
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
    return { usedUsd: used, allowedUsd: cap > 0 ? Math.min(limit, cap) : limit };
  }

  /** USD still allowed this month: the account limit (or a lower cap) minus usage. */
  async remainingBudgetUsd(): Promise<number> {
    const u = await this.usage();
    return Math.max(0, u.allowedUsd - u.usedUsd);
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

  /** A TikTok account's public profile: name, bio, followers, likes and videos. */
  async tiktokProfile(handle: string): Promise<RemoteAccount> {
    const items = await this.run(
      this.actors.tiktok,
      {
        profiles: [handle.replace(/^@/, "")],
        resultsPerPage: 1,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      },
      1,
    );
    const author = (items[0]?.authorMeta ?? items[0]?.author ?? null) as Item | null;
    if (!author) throw new AccountNotFoundError(`TikTok @${handle} not found or private`);
    return {
      displayName: str(pick(author, "nickName", "nickname")),
      bio: str(pick(author, "signature", "bio")),
      followers: num(pick(author, "fans", "followers", "followerCount")),
      stats: {
        likes: num(pick(author, "heart", "hearts", "heartCount")),
        videos: num(pick(author, "video", "videos", "videoCount")),
        following: num(pick(author, "following", "followingCount")),
        verified: pick(author, "verified") === true,
      },
      links: [str(pick(author, "bioLink", "bioLinkUrl"))].filter((l): l is string => !!l),
    };
  }

  /** Same actor and price as the followers list. */
  get followingCostPer1k() {
    return this.costPer1k;
  }

  /** Accounts a public account follows (the same actor as followers, other direction). */
  async listFollowing(username: string, limit: number): Promise<string[]> {
    const items = await this.run(
      this.actors.followers,
      { usernames: [username.replace(/^@/, "")], dataToScrape: "following", resultsLimit: limit },
      limit,
    );
    return usernamesFrom(items).filter((u) => u !== username.toLowerCase());
  }

  /** About $4 per 1000 places on the public actor's pricing. */
  readonly placesCostPer1k = 4;

  /** Businesses on Google Maps for a search ("مكتب صرافة") in a place ("الرياض"). */
  async searchPlaces(query: string, location: string, limit: number): Promise<RawPlace[]> {
    const items = await this.run(
      this.actors.places,
      {
        searchStringsArray: [query],
        locationQuery: location,
        maxCrawledPlacesPerSearch: limit,
        language: "ar",
        skipClosedPlaces: true,
      },
      limit,
    );
    return items
      .map((it) => ({
        placeId: str(pick(it, "placeId", "cid", "fid")) ?? "",
        name: str(pick(it, "title", "name")) ?? "",
        category: str(pick(it, "categoryName", "category")),
        address: str(pick(it, "address")),
        city: str(pick(it, "city")),
        country: str(pick(it, "countryCode"))?.toUpperCase().slice(0, 2) ?? null,
        phone: str(pick(it, "phone", "phoneUnformatted")),
        website: str(pick(it, "website")),
        rating: num(pick(it, "totalScore", "rating")),
        reviews: num(pick(it, "reviewsCount", "reviews")),
        url: str(pick(it, "url")),
      }))
      .filter((p) => p.placeId && p.name);
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
    if (source.type === "followers") {
      // The followers list itself. Instagram and the actor's plan may return
      // fewer than asked (Apify's free usage covers the first page).
      const items = await this.run(
        this.actors.followers,
        { usernames: [source.username], dataToScrape: "followers", resultsLimit: limit },
        limit,
      );
      for (const u of usernamesFrom(items)) if (u !== source.username) yield u;
      return;
    }
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
        {
          username: [source.username],
          resultsLimit: this.opts.recentPosts ?? DEFAULT_RECENT_POSTS,
        },
        this.opts.recentPosts ?? DEFAULT_RECENT_POSTS,
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
