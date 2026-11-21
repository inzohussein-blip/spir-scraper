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
}

export interface AudienceStats {
  total: number;
  segments: Record<string, number>;
  languages: Record<string, number>;
  countries: Record<string, number>;
  top: Array<{ username: string; followers: number | null; segment: string; score: number }>;
}
