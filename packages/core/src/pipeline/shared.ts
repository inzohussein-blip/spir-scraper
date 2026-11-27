import { createHash } from "node:crypto";
import type { AnyDb, LeadStatus } from "@scrapers/db";
import type { PgBoss } from "pg-boss";
import type { ResolveDeps } from "../extract/index.js";
import type { NotificationSink } from "../notify.js";
import type { Scorer } from "../scoring.js";
import type {
  Connector,
  DataTools,
  FollowingSource,
  OwnAccount,
  PlacesSearch,
  Source,
} from "../types.js";
import type { ProviderRouter } from "./router.js";

export const QUEUES = {
  discover: "scrapers-discover",
  enrich: "scrapers-enrich",
  retention: "scrapers-retention",
} as const;

export const ENRICH_BATCH = 50;
/** Accounts of a batch processed at the same time (after their profiles are read). */
export const ENRICH_CONCURRENCY = 8;

export interface ScrapersConfig {
  suppressionPepper: string;
  maxJobLimit?: number;
  defaultRetentionDays?: number;
  /** Reuse a profile fetched within this many days instead of fetching it again (0 disables). */
  profileCacheDays?: number;
  /**
   * Followers and hashtag lists above this many accounts are collected by a
   * background run (Apify) instead of one long request (default 300).
   */
  backgroundAbove?: number;
  /** Where the provider reports a finished background run (null: found by polling). */
  discoveryNotifyUrl?: string | null;
  /** Weekly summary day (0 = Sunday … 5 = Friday) and time zone. */
  weeklyDay?: number;
  timeZone?: string;
}

export interface DiscoverPayload {
  jobId: string;
  /** Only for upload sources: the usernames read from the CSV. */
  usernames?: string[];
}

export interface EnrichPayload {
  jobId: string;
  usernames: string[];
}

export interface LeadFilters {
  projectId: string;
  jobId?: string;
  business?: boolean;
  hasEmail?: boolean;
  hasPhone?: boolean;
  minScore?: number;
  status?: LeadStatus;
  /** Text search in username, name and bio. */
  q?: string;
  /** ISO 3166-1 alpha-2. */
  country?: string;
  /** ISO 639-1 (ar, en, ...). */
  language?: string;
  /** Found in at least this many sources (competitors, posts). */
  minSources?: number;
  minFollowers?: number;
  maxFollowers?: number;
  /** Audience segment (see buildPersonas). */
  persona?: string;
  /** A timing signal such as rising or became_business. */
  signal?: string;
  /** Words or phrases with the same meaning; a lead matches any of them. */
  terms?: string[];
  /** Has an account on this other platform (youtube, telegram, tiktok, website...). */
  platform?: string;
  /** Model's chance of becoming a customer at least this high (0-100). */
  minWinProb?: number;
  limit?: number;
  offset?: number;
  /** Opaque cursor from a previous page (keyset pagination). */
  cursor?: string;
}

export const LEAD_STATUSES: readonly LeadStatus[] = [
  "new",
  "contacted",
  "interested",
  "customer",
  "rejected",
];

/** A lead joined with its profile: what list_leads and the exporters return. */
export interface LeadRow {
  username: string;
  fullName: string | null;
  category: string | null;
  followers: number | null;
  isBusiness: boolean;
  email: string | null;
  phone: string | null;
  phoneCountry: string | null;
  phoneConfirmed: boolean;
  contactSource: string | null;
  aiScore: number | null;
  aiTags: string[] | null;
  aiReason: string | null;
  status: LeadStatus;
  statusNote: string | null;
  city: string | null;
  engagementRate: number | null;
  qualityFlags: string[] | null;
  /** How many other projects also hold this person. */
  otherProjects: number;
  sourceUrl: string;
  fetchedAt: Date;
  /** When the owner asked to be reminded to follow up. */
  followUpAt?: Date | null;
  /** Sources the account was found in, and how many. */
  sources?: string[] | null;
  sourceCount?: number;
  country?: string | null;
  language?: string | null;
  /** Value of the closed deal, when recorded. */
  dealValue?: number | null;
  /** Chance (0-100) it becomes a customer, by the project's own model. */
  winProb?: number | null;
  persona?: string | null;
  signals?: string[] | null;
}

/** Lead statuses in Arabic, for reminders. */
export const STATUS_AR: Record<string, string> = {
  new: "جديد",
  contacted: "تواصلت",
  interested: "مهتم",
  customer: "عميل",
  rejected: "مرفوض",
};

export class JobNotFoundError extends Error {
  override name = "JobNotFoundError";
}

export class ScoringUnavailableError extends Error {
  override name = "ScoringUnavailableError";
}

export type ApiScope = "read" | "write";

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** What the service needs from its caller (database, queue, providers, settings, optional parts). */
export interface ScrapersDeps {
  db: AnyDb;
  boss: PgBoss;
  router: ProviderRouter;
  config: ScrapersConfig;
  /** Optional AI scorer (needs ANTHROPIC_API_KEY). */
  scorer?: Scorer | undefined;
  /** Extra places notifications go, e.g. Telegram. */
  sinks?: NotificationSink[];
  /** Public dashboard URL, used to build links in notifications. */
  appUrl?: string;
  /** Network steps of contact extraction (link-in-bio pages, MX check). Defaults to the real ones. */
  resolve?: ResolveDeps;
  /** Called when a finished job (scored, if the project has AI criteria) is ready to export. */
  onReadyToExport?: (jobId: string) => Promise<void>;
  /** Readers for other platforms (YouTube, Telegram...), one per platform. */
  connectors?: Connector[];
  /** Google Maps search (Apify). */
  places?: PlacesSearch;
  /** The owner's own Instagram account (Graph API), for comments and messages. */
  own?: OwnAccount;
  /** Who an account follows (Apify), for finding new sources from the best customers. */
  following?: FollowingSource;
  /** Reads one public web page (for watching competitor sites). */
  readPage?: (url: string) => Promise<{ title: string | null; text: string }>;
  /** Services the «المتجر» tools run on (Apify Actors, YouTube API). */
  tools?: DataTools;
}

/** The few public methods the pipeline itself calls (bound once the service exists). */
export interface LateApi {
  deepContactSearch(input: {
    jobId?: string;
    reread?: boolean;
    limit?: number;
    budgetMs?: number;
  }): Promise<{ checked: number; found: number; emails: number; phones: number; costUsd: number }>;
  createEngineRun(input: {
    name: string;
    projectId: string;
    seeds: string[];
    maxDepth?: number;
    maxAccounts?: number;
  }): Promise<unknown>;
}

export function sourceFromJob(job: {
  sourceType: string;
  sourceUrl: string;
}): Exclude<Source, { type: "upload" }> {
  const parts = new URL(job.sourceUrl).pathname.split("/").filter(Boolean);
  if (job.sourceType === "post")
    return { type: "post", shortcode: parts[1] ?? "", url: job.sourceUrl };
  if (job.sourceType === "hashtag")
    return { type: "hashtag", tag: decodeURIComponent(parts[2] ?? ""), url: job.sourceUrl };
  if (job.sourceType === "followers")
    return { type: "followers", username: parts[0] ?? "", url: job.sourceUrl };
  if (job.sourceType === "search")
    return {
      type: "search",
      query: new URL(job.sourceUrl).searchParams.get("q") ?? "",
      url: job.sourceUrl,
    };
  if (job.sourceType === "location")
    return { type: "location", locationId: parts[2] ?? "", url: job.sourceUrl };
  if (job.sourceType === "similar")
    return { type: "similar", username: parts[0] ?? "", url: job.sourceUrl };
  return { type: "profile", username: parts[0] ?? "", url: job.sourceUrl };
}
