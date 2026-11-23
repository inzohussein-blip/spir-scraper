/** A public Instagram profile as returned by any provider, before extraction. */
export interface RawProfile {
  igUserId: string;
  username: string;
  fullName?: string | null;
  bio?: string | null;
  followers?: number | null;
  following?: number | null;
  posts?: number | null;
  isBusiness: boolean;
  isVerified: boolean;
  category?: string | null;
  externalUrl?: string | null;
  /** Public "Email" contact button (business/creator accounts). */
  businessEmail?: string | null;
  /** Public "Call"/"WhatsApp" contact button. */
  businessPhone?: string | null;
  /** Country calling code that accompanies businessPhone, e.g. "966". */
  businessPhoneCountryCode?: string | null;
  /** WhatsApp number from the business contact options, when shown. */
  businessWhatsapp?: string | null;
  /** City from the business address, when shown. */
  city?: string | null;
  /** Likes and comments of recent posts, for engagement and quality checks. */
  recentPosts?: RecentPost[] | null;
}

/** A recent post as providers return it; only likes and comments are always present. */
export interface RecentPost {
  likes: number | null;
  comments: number | null;
  caption?: string | null;
  /** ISO time the post was published. */
  timestamp?: string | null;
  /** image | video | carousel */
  type?: string | null;
  url?: string | null;
}

/** What a connector reads about an account on another platform. */
export interface RemoteAccount {
  displayName: string | null;
  bio: string | null;
  /** Followers, subscribers or members. */
  followers: number | null;
  stats?: Record<string, unknown>;
  /** Addresses of the person's other accounts found while reading (e.g. links on their website). */
  links?: string[];
}

/**
 * Reads public accounts on one platform through its official interface
 * (YouTube Data API, Telegram Bot API, ...). One connector per platform.
 */
export interface Connector {
  /** A Platform from extract/accounts (tiktok, youtube, telegram, ...). */
  readonly platform: string;
  /** Each read costs money (e.g. through Apify): only read when the owner asks. */
  readonly paid?: boolean;
  /** Throws AccountNotFoundError when the account does not exist or is private. */
  getAccount(handle: string): Promise<RemoteAccount>;
}

/** A business from Google Maps as a provider returns it. */
export interface RawPlace {
  placeId: string;
  name: string;
  category?: string | null;
  address?: string | null;
  city?: string | null;
  /** ISO 3166-1 alpha-2. */
  country?: string | null;
  phone?: string | null;
  website?: string | null;
  rating?: number | null;
  reviews?: number | null;
  url?: string | null;
}

/** Searches Google Maps (e.g. through Apify). */
export interface PlacesSearch {
  /** Approximate USD per 1000 places. */
  readonly placesCostPer1k: number;
  searchPlaces(query: string, location: string, limit: number): Promise<RawPlace[]>;
}

/** Lists the accounts an Instagram account follows (e.g. through Apify). */
export interface FollowingSource {
  /** Approximate USD per 1000 accounts listed. */
  readonly followingCostPer1k: number;
  listFollowing(username: string, limit: number): Promise<string[]>;
}

export interface OwnMedia {
  id: string;
  caption: string | null;
  permalink: string | null;
  type: string | null;
  timestamp: string | null;
  likes: number | null;
  comments: number | null;
}

export interface OwnComment {
  id: string;
  text: string;
  username: string | null;
  timestamp: string | null;
}

/** The owner's own Instagram account (Graph API): posts, comments and replies. */
export interface OwnAccount {
  listMedia(limit: number): Promise<OwnMedia[]>;
  listComments(mediaId: string, limit: number): Promise<OwnComment[]>;
  sendMessage(recipientId: string, text: string): Promise<{ id: string }>;
}

export class AccountNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountNotFoundError";
  }
}

export type ProviderId = "graph" | "apify" | "worker";

export type SourceType =
  | "profile"
  | "followers"
  | "post"
  | "hashtag"
  | "search"
  | "location"
  | "similar"
  | "upload";

export type Source =
  | { type: "profile"; username: string; url: string }
  /** The account's followers list (needs a provider with account_followers). */
  | { type: "followers"; username: string; url: string }
  | { type: "post"; shortcode: string; url: string }
  | { type: "hashtag"; tag: string; url: string }
  /** Accounts Instagram's search finds for words such as «مدرب تداول». */
  | { type: "search"; query: string; url: string }
  /** People who posted from a place (an Instagram location page). */
  | { type: "location"; locationId: string; url: string }
  /** Accounts Instagram suggests as similar to this one. */
  | { type: "similar"; username: string; url: string }
  | { type: "upload"; usernames: string[]; url: string };

export type Capability =
  | "profile"
  | "business_contact"
  | "post_commenters"
  | "hashtag_posters"
  | "account_engagers"
  | "account_followers"
  | "keyword_search"
  | "location_posters"
  | "similar_accounts";

export interface Provider {
  readonly id: ProviderId;
  readonly capabilities: ReadonlySet<Capability>;
  /** Requests per minute this provider is allowed to make. */
  readonly ratePerMinute: number;
  /** Approximate USD cost per 1000 results, shown before a job runs. */
  readonly costPer1k?: number | undefined;
  getProfile(username: string): Promise<RawProfile>;
  /**
   * Many profiles in one call (one Apify run instead of one per account).
   * Accounts that do not exist or are private are simply absent.
   */
  getProfiles?(usernames: string[]): Promise<RawProfile[]>;
  /**
   * Starts collecting a large list in the background (no request has to stay
   * open while it runs). `notifyUrl` is called when the run ends, if given.
   * Only for sources a single run can collect (followers, hashtags).
   */
  startEngagers?(
    source: Exclude<Source, { type: "upload" }>,
    limit: number,
    notifyUrl: string | null,
  ): Promise<{ runId: string } | null>;
  /** The state of a background run; when done, the usernames it found. */
  collectEngagers?(
    runId: string,
    source: Exclude<Source, { type: "upload" }>,
    limit: number,
  ): Promise<
    | { status: "running" }
    | { status: "done"; usernames: string[] }
    | { status: "failed"; error: string }
  >;
  /** Yields usernames related to the source (commenters, posters, ...). */
  listEngagers?(source: Exclude<Source, { type: "upload" }>, limit: number): AsyncIterable<string>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
/** HTTP 429 or equivalent: back off and try another provider. */
export class RateLimitedError extends ProviderError {}
/** Login wall, challenge or ban: never retried on the same provider. */
export class BlockedError extends ProviderError {}
/** The account does not exist or is private. */
export class NotFoundError extends ProviderError {}
/** The spending cap for a paid provider has been reached. */
export class BudgetExceededError extends ProviderError {}
