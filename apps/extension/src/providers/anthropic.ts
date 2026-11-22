import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatModel,
  ModelSettings,
  ModelTurn,
  StopReason,
  ToolCall,
  ToolResult,
  ToolSpec,
} from "./types.js";
import { ProviderError } from "./types.js";

type Msg = Anthropic.Beta.BetaMessageParam;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set([
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const ANTHROPIC_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (الأقوى)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (الأرخص والأسرع)" },
];

/**
 * Claude through the official SDK, run from the extension page. The whole
 * assistant content (thinking blocks included) is appended back unchanged on
 * every turn, as the API requires.
 */
export class AnthropicModel implements ChatModel {
  readonly label: string;
  readonly vision = true;
  private readonly client: Anthropic;
  private readonly messages: Msg[] = [];

  constructor(
    private readonly settings: ModelSettings,
    private readonly system: string,
    private readonly tools: ToolSpec[],
    private readonly effort: Effort = "medium",
    client?: Anthropic,
  ) {
    this.label = settings.model;
    this.client =
      client ??
      new Anthropic({
        apiKey: settings.apiKey,
        // The key belongs to the extension's owner and stays in this browser.
        dangerouslyAllowBrowser: true,
      });
  }

  sendUser(text: string, signal?: AbortSignal) {
    this.messages.push({ role: "user", content: text });
    return this.run(signal);
  }

  sendToolResults(results: ToolResult[], signal?: AbortSignal) {
    // Every result of one turn goes back in a single user message.
    this.messages.push({
      role: "user",
      content: results.map(
        (r): Anthropic.Beta.BetaToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: r.id,
          is_error: r.isError ?? false,
          content: [
            { type: "text", text: r.content || "(empty)" },
            ...(r.image
              ? [
                  {
                    type: "image" as const,
                    source: {
                      type: "base64" as const,
                      media_type: r.image.mediaType,
                      data: r.image.data,
                    },
                  },
                ]
              : []),
          ],
        }),
      ),
    });
    return this.run(signal);
  }

  private async run(signal?: AbortSignal): Promise<ModelTurn> {
    const fallback = FALLBACK_MODELS.has(this.settings.model);
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.settings.model,
          max_tokens: 16000,
          system: this.system,
          ...(this.tools.length
            ? {
                tools: this.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters,
                })),
              }
            : {}),
          messages: this.messages,
          output_config: { effort: this.effort },
          ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
        },
        signal ? { signal } : {},
      );
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError)
        throw new ProviderError("مفتاح Claude غير صحيح", 401);
      if (err instanceof Anthropic.RateLimitError)
        throw new ProviderError("تجاوزت حد الطلبات في Claude، انتظر قليلاً", 429);
      if (err instanceof Anthropic.APIError)
        throw new ProviderError(`Claude: ${err.message}`, err.status);
      throw err;
    }
    this.messages.push({ role: "assistant", content: response.content });

    const toolCalls: ToolCall[] = [];
    const text: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") text.push(block.text);
      else if (block.type === "tool_use")
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
    }
    const stop: StopReason =
      response.stop_reason === "refusal"
        ? "refusal"
        : response.stop_reason === "max_tokens"
          ? "max_tokens"
          : toolCalls.length > 0
            ? "tool_use"
            : "end";
    return { text: text.join("\n").trim(), toolCalls, stop };
  }
}
