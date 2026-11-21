import type Anthropic from "@anthropic-ai/sdk";
import type { ScoringInput } from "@scrapers/core";
import { describe, expect, it } from "vitest";
import { AnthropicScorer } from "../src/index.js";

const item = (id: string, over: Partial<ScoringInput> = {}): ScoringInput => ({
  id,
  username: `u${id}`,
  fullName: null,
  bio: "مدرب تداول 🇸🇦",
  followers: 5000,
  isBusiness: true,
  isVerified: false,
  category: null,
  externalUrl: null,
  ...over,
});

const good = {
  segment: "educator",
  language: "ar",
  country: "SA",
  score: 82,
  reason: "مدرب",
} as const;

function fakeClient(impl: {
  parse?: (params: Record<string, unknown>) => unknown;
  batchStatus?: string;
  results?: unknown[];
  beta?: (params: Record<string, unknown>) => unknown;
}) {
  const calls: Record<string, unknown[]> = { parse: [], create: [], beta: [] };
  const client = {
    messages: {
      parse: async (p: Record<string, unknown>) => {
        calls.parse?.push(p);
        return impl.parse?.(p);
      },
      batches: {
        create: async (p: unknown) => {
          calls.create?.push(p);
          return { id: "msgbatch_1" };
        },
        retrieve: async () => ({ processing_status: impl.batchStatus ?? "ended" }),
        results: async () =>
          (async function* () {
            for (const r of impl.results ?? []) yield r;
          })(),
      },
    },
    beta: {
      messages: {
        create: async (p: Record<string, unknown>) => {
          calls.beta?.push(p);
          return impl.beta?.(p);
        },
      },
    },
  } as unknown as Pick<Anthropic, "messages" | "beta">;
  return { client, calls };
}

describe("AnthropicScorer", () => {
  it("scores with Haiku, structured output, low effort, cached system prompt and no contact data", async () => {
    const { client, calls } = fakeClient({
      parse: () => ({ stop_reason: "end_turn", parsed_output: good }),
    });
    const s = new AnthropicScorer({ client });
    const out = await s.scoreNow([item("a"), item("b")], "وكلاء في الخليج");
    expect([...out.keys()].sort()).toEqual(["a", "b"]);
    expect(out.get("a")).toEqual(good);
    const p = calls.parse?.[0] as Record<string, any>;
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.output_config.effort).toBe("low");
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(p.system[0].text).toContain("وكلاء في الخليج");
    const sent = JSON.parse(p.messages[0].content);
    expect(Object.keys(sent)).not.toContain("email");
    expect(sent.bio).toBe("مدرب تداول 🇸🇦");
  });

  it("skips refusals, unparseable answers and errors", async () => {
    const errors: string[] = [];
    let n = 0;
    const { client } = fakeClient({
      parse: () => {
        n++;
        if (n === 1) return { stop_reason: "refusal", parsed_output: null };
        if (n === 2) return { stop_reason: "end_turn", parsed_output: null };
        throw new Error("overloaded");
      },
    });
    const s = new AnthropicScorer({
      client,
      concurrency: 1,
      onError: (e) => errors.push((e as Error).message),
    });
    expect((await s.scoreNow([item("a"), item("b"), item("c")], "")).size).toBe(0);
    expect(errors).toEqual(["overloaded"]);
  });

  it("submits a batch keyed by lead id", async () => {
    const { client, calls } = fakeClient({});
    const s = new AnthropicScorer({ client });
    expect(await s.submitBatch([item("lead-1")], "x")).toBe("msgbatch_1");
    const req = (calls.create?.[0] as any)?.requests[0];
    expect(req.custom_id).toBe("lead-1");
    expect(req.params.model).toBe("claude-haiku-5-5");
    expect(req.params.output_config.format.schema).toBeDefined();
  });

  it("collects batch results in any order and validates them", async () => {
    const msg = (text: string, stop = "end_turn") => ({
      type: "succeeded",
      message: { stop_reason: stop, content: [{ type: "text", text }] },
    });
    const { client } = fakeClient({
      results: [
        { custom_id: "b", result: msg(JSON.stringify(good)) },
        { custom_id: "a", result: msg(JSON.stringify({ ...good, score: 500 })) },
        { custom_id: "c", result: msg("not json") },
        { custom_id: "d", result: { type: "errored", error: { type: "server_error" } } },
        { custom_id: "e", result: msg(JSON.stringify(good), "refusal") },
      ],
    });
    const out = await new AnthropicScorer({ client }).collectBatch("msgbatch_1");
    expect(out && [...out.keys()]).toEqual(["b"]);
  });

  it("returns null while a batch is processing", async () => {
    const { client } = fakeClient({ batchStatus: "in_progress" });
    expect(await new AnthropicScorer({ client }).collectBatch("x")).toBeNull();
  });

  it("writes the report with Sonnet and server-side fallbacks", async () => {
    const { client, calls } = fakeClient({
      beta: () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "## تقرير" }] }),
    });
    const stats = {
      total: 1,
      segments: { educator: 1 },
      languages: { ar: 1 },
      countries: {},
      top: [],
    };
    expect(await new AnthropicScorer({ client }).report(stats, "c")).toBe("## تقرير");
    const p = calls.beta?.[0] as Record<string, any>;
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    const refused = fakeClient({ beta: () => ({ stop_reason: "refusal", content: [] }) });
    expect(await new AnthropicScorer({ client: refused.client }).report(stats, "c")).toBe("");
  });
});
