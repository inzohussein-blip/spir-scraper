import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  AudienceStats,
  CompetitorBriefInput,
  LeadQuery,
  LeadScore,
  Scorer,
  ScoringInput,
} from "@scrapers/core";
import { z } from "zod";

export const LeadScoreSchema = z.object({
  segment: z.enum([
    "individual_trader",
    "educator",
    "finance_creator",
    "potential_partner",
    "business",
    "irrelevant",
    "bot_or_fake",
  ]),
  language: z.string().describe("ISO 639-1 code of the bio's main language, e.g. ar, en"),
  country: z
    .string()
    .nullable()
    .describe("ISO 3166-1 alpha-2 code if the profile states it, else null"),
  score: z.number().int().min(0).max(100),
  reason: z.string().describe("One short sentence explaining the score"),
});

export const LeadQuerySchema = z.object({
  status: z.enum(["new", "contacted", "interested", "customer", "rejected"]).nullable(),
  minScore: z.number().int().min(0).max(100).nullable(),
  country: z.string().nullable().describe("ISO 3166-1 alpha-2, e.g. KW for Kuwait"),
  language: z.string().nullable().describe("ISO 639-1, e.g. ar"),
  business: z.boolean().nullable(),
  hasEmail: z.boolean().nullable(),
  hasPhone: z.boolean().nullable(),
  minFollowers: z.number().int().min(0).nullable(),
  maxFollowers: z.number().int().min(0).nullable(),
  minSources: z.number().int().min(1).nullable(),
  q: z.string().nullable().describe("Keywords to find in the username, name or bio"),
});

const QUERY_SYSTEM = `You turn a marketer's question about their saved Instagram leads into filters.
Fields: status (new=جديد, contacted=تواصلت, interested=مهتم, customer=عميل, rejected=مرفوض), minScore (AI fit 0-100),
country (ISO alpha-2; Gulf countries are SA, AE, KW, QA, BH, OM), language, business (business account),
hasEmail, hasPhone, minFollowers, maxFollowers, minSources (found in at least N competitors' audiences),
q (words to search in the bio). Set only what the question asks for; everything else is null.
"Good" or "strong" leads mean minScore 70 unless a number is given.`;

const SYSTEM = `You classify public Instagram profiles as potential business leads.

For each profile you receive (username, name, bio, follower count, account type, category, link), return:
- segment: the best-fitting category.
  individual_trader: a person who trades for themselves.
  educator: teaches trading or runs courses/signals.
  finance_creator: posts finance content for an audience.
  potential_partner: could become an agent, affiliate or introducing broker.
  business: a company or shop that is not one of the above.
  irrelevant: unrelated to the criteria.
  bot_or_fake: spam, bot, empty or impersonation account.
- language and country: only from what the profile itself shows. Use null for country when it is not stated. Never guess from the name alone.
- score: 0-100 fit against the operator's criteria below. Use the full range.
- found_in_sources: in how many competitor audiences or posts the account was found. Several means a stronger interest in the niche; weigh it up.
- reason: one short sentence, in the profile's language when it is Arabic, otherwise English.

Use only the information given. Do not invent facts about the person.`;

type ParseClient = Pick<Anthropic, "messages" | "beta">;

export interface AnthropicScorerOptions {
  client?: ParseClient;
  /** Model for per-profile scoring. */
  model?: string;
  /** Model for the audience report. */
  reportModel?: string;
  /** Above this many profiles, the Message Batches API is used (50% cheaper, async). */
  batchThreshold?: number;
  concurrency?: number;
  onError?: (err: unknown, item: ScoringInput) => void;
}

function profileMessage(item: ScoringInput): string {
  return JSON.stringify({
    username: item.username,
    name: item.fullName,
    bio: item.bio,
    followers: item.followers,
    business_account: item.isBusiness,
    verified: item.isVerified,
    category: item.category,
    link: item.externalUrl,
    found_in_sources: item.sources ?? 1,
  });
}

function systemBlocks(criteria: string): Anthropic.TextBlockParam[] {
  // Stable instructions + per-project criteria first, cached across all calls of a job.
  // (Short prompts fall below the model's minimum cacheable length and simply are not cached.)
  return [
    {
      type: "text",
      text: `${SYSTEM}\n\nOperator's criteria:\n${criteria.trim() || "General fit as a partner or client for a trading business."}`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

function requestParams(item: ScoringInput, criteria: string) {
  return {
    model: "",
    max_tokens: 2048,
    system: systemBlocks(criteria),
    output_config: { effort: "low" as const, format: zodOutputFormat(LeadScoreSchema) },
    messages: [{ role: "user" as const, content: profileMessage(item) }],
  };
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Scores profiles with Claude using structured outputs; large sets go through Message Batches. */
export class AnthropicScorer implements Scorer {
  readonly batchThreshold: number;
  private readonly client: ParseClient;
  private readonly model: string;
  private readonly reportModel: string;
  private readonly concurrency: number;

  constructor(private readonly opts: AnthropicScorerOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? "claude-haiku-5-5";
    this.reportModel = opts.reportModel ?? "claude-sonnet-5-5";
    this.batchThreshold = opts.batchThreshold ?? 100;
    this.concurrency = opts.concurrency ?? 5;
  }

  async scoreNow(items: ScoringInput[], criteria: string): Promise<Map<string, LeadScore>> {
    const out = new Map<string, LeadScore>();
    await pool(items, this.concurrency, async (item) => {
      try {
        const res = await this.client.messages.parse({
          ...requestParams(item, criteria),
          model: this.model,
        });
        // A refused or unparseable answer leaves the lead unscored rather than guessing.
        if (res.stop_reason === "refusal" || !res.parsed_output) return;
        out.set(item.id, res.parsed_output);
      } catch (err) {
        this.opts.onError?.(err, item);
      }
    });
    return out;
  }

  async submitBatch(items: ScoringInput[], criteria: string): Promise<string> {
    const batch = await this.client.messages.batches.create({
      requests: items.map((item) => ({
        custom_id: item.id,
        params: { ...requestParams(item, criteria), model: this.model },
      })),
    });
    return batch.id;
  }

  async collectBatch(batchId: string): Promise<Map<string, LeadScore> | null> {
    const batch = await this.client.messages.batches.retrieve(batchId);
    if (batch.processing_status !== "ended") return null;
    const out = new Map<string, LeadScore>();
    // Results arrive in any order: key by custom_id.
    for await (const r of await this.client.messages.batches.results(batchId)) {
      if (r.result.type !== "succeeded" || r.result.message.stop_reason === "refusal") continue;
      const text = r.result.message.content.find((b) => b.type === "text");
      if (text?.type !== "text") continue;
      try {
        const parsed = LeadScoreSchema.safeParse(JSON.parse(text.text));
        if (parsed.success) out.set(r.custom_id, parsed.data);
      } catch {
        // Malformed JSON: leave unscored.
      }
    }
    return out;
  }

  async report(stats: AudienceStats, criteria: string): Promise<string> {
    const res = await this.client.beta.messages.create({
      model: this.reportModel,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system:
        "You write short audience reports in Arabic for a marketer. Use only the numbers given. " +
        "Structure: a two-sentence summary, the segment split, languages and countries, the strongest accounts and why, " +
        "and three concrete content or outreach ideas. Markdown, under 300 words.",
      messages: [
        {
          role: "user",
          content: `Criteria: ${criteria || "general"}\n\nAudience data (JSON):\n${JSON.stringify(stats)}`,
        },
      ],
    });
    if (res.stop_reason === "refusal") return "";
    return res.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim();
  }

  async parseQuery(question: string): Promise<LeadQuery> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: 1024,
      system: QUERY_SYSTEM,
      output_config: { effort: "low", format: zodOutputFormat(LeadQuerySchema) },
      messages: [{ role: "user", content: question.slice(0, 500) }],
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) return {};
    // Drop nulls: only what the question asked for becomes a filter.
    return Object.fromEntries(
      Object.entries(res.parsed_output).filter(([, v]) => v !== null && v !== ""),
    ) as LeadQuery;
  }

  async competitorBrief(input: CompetitorBriefInput, criteria: string): Promise<string> {
    const res = await this.client.beta.messages.create({
      model: this.reportModel,
      max_tokens: 6000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system:
        "You analyse a competitor's public Instagram account for a marketer, in Arabic. Use only the data given. " +
        "Structure: what the account is about and who it attracts (two sentences), what content works best and when they post, " +
        "growth if given, then five concrete content ideas the marketer can make to win that audience. Markdown, under 300 words.",
      messages: [
        {
          role: "user",
          content: `Marketer's goal: ${criteria || "general"}\n\nCompetitor data (JSON):\n${JSON.stringify(input)}`,
        },
      ],
    });
    if (res.stop_reason === "refusal") return "";
    return res.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim();
  }
}
