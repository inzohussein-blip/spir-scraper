/** What the AI layer returns for one profile (docs/PLAN.md §10). */
export interface LeadScore {
  segment:
    | "individual_trader"
    | "educator"
    | "finance_creator"
    | "potential_partner"
    | "business"
    | "irrelevant"
    | "bot_or_fake";
  language: string;
  country: string | null;
  score: number;
  reason: string;
}

/** The profile fields sent to the model. Contact details are never sent. */
export interface ScoringInput {
  id: string;
  username: string;
  fullName: string | null;
  bio: string | null;
  followers: number | null;
  isBusiness: boolean;
  isVerified: boolean;
  category: string | null;
  externalUrl: string | null;
  /** How many of the project's sources (competitors, posts) the account was found in. */
  sources?: number;
}

/** Lead filters understood from a question in plain language. */
export interface LeadQuery {
  status?: "new" | "contacted" | "interested" | "customer" | "rejected";
  minScore?: number;
  /** ISO 3166-1 alpha-2. */
  country?: string;
  /** ISO 639-1. */
  language?: string;
  business?: boolean;
  hasEmail?: boolean;
  hasPhone?: boolean;
  minFollowers?: number;
  maxFollowers?: number;
  /** Found in at least this many sources. */
  minSources?: number;
  /** Words to look for in the username, name and bio. */
  q?: string;
  /** Words and phrases with the asked meaning, in Arabic and English (any may match). */
  terms?: string[];
  /** Audience segment name, when the question names one. */
  persona?: string;
  /** rising | became_business */
  signal?: string;
}

/** An audience segment found in a project's bios. */
export interface Persona {
  name: string;
  description: string;
  keywords: string[];
}

/** What the competitor brief is written from. */
export interface CompetitorBriefInput {
  username: string;
  bio: string | null;
  category: string | null;
  followers: number | null;
  growthPercent: number | null;
  analysis: unknown;
  captions: string[];
}

/**
 * The AI scorer, implemented by @scrapers/ai. Small sets are scored right
 * away; large sets go to the Message Batches API and are collected later.
 */
export interface Scorer {
  /** Above this many items, submitBatch is used instead of scoreNow. */
  readonly batchThreshold: number;
  scoreNow(items: ScoringInput[], criteria: string): Promise<Map<string, LeadScore>>;
  submitBatch(items: ScoringInput[], criteria: string): Promise<string>;
  /** Returns null while the batch is still processing. */
  collectBatch(batchId: string): Promise<Map<string, LeadScore> | null>;
  report?(stats: AudienceStats, criteria: string): Promise<string>;
  /** Turns an Arabic or English question into lead filters. */
  parseQuery?(question: string): Promise<LeadQuery>;
  /** Audience segments in a sample of bios, each with words that mark it. */
  personas?(
    sample: { username: string; bio: string | null; category: string | null }[],
    criteria: string,
  ): Promise<Persona[]>;
  /** A short Arabic brief on a competitor with content ideas. */
  competitorBrief?(input: CompetitorBriefInput, criteria: string): Promise<string>;
}

export interface AudienceStats {
  total: number;
  segments: Record<string, number>;
  languages: Record<string, number>;
  countries: Record<string, number>;
  top: Array<{ username: string; followers: number | null; segment: string; score: number }>;
}
