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
}

export type ProviderId = "graph" | "apify" | "worker";

export type SourceType = "profile" | "post" | "hashtag" | "upload";

export type Source =
  | { type: "profile"; username: string; url: string }
  | { type: "post"; shortcode: string; url: string }
  | { type: "hashtag"; tag: string; url: string }
  | { type: "upload"; usernames: string[]; url: string };

export type Capability =
  | "profile"
  | "business_contact"
  | "post_commenters"
  | "hashtag_posters"
  | "account_engagers";

export interface Provider {
  readonly id: ProviderId;
  readonly capabilities: ReadonlySet<Capability>;
  /** Requests per minute this provider is allowed to make. */
  readonly ratePerMinute: number;
  /** Approximate USD cost per 1000 results, shown before a job runs. */
  readonly costPer1k?: number | undefined;
  getProfile(username: string): Promise<RawProfile>;
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
