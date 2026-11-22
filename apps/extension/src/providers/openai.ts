import type {
  ChatModel,
  FetchLike,
  ModelSettings,
  ModelTurn,
  ToolResult,
  ToolSpec,
} from "./types.js";
import { errorText, ProviderError } from "./types.js";

/**
 * Any server that speaks the OpenAI Chat Completions API: OpenAI, OpenRouter,
 * Groq, DeepSeek, Together, and local Ollama or LM Studio.
 */
const DEFAULT_BASE = "https://api.openai.com/v1";

export const OPENAI_COMPATIBLE_PRESETS = [
  { label: "OpenAI", baseUrl: DEFAULT_BASE },
  { label: "OpenRouter (مئات النماذج)", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { label: "Ollama (على جهازك)", baseUrl: "http://localhost:11434/v1" },
  { label: "LM Studio (على جهازك)", baseUrl: "http://localhost:1234/v1" },
];

type Message =
  | { role: "system" | "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
type WireToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export class OpenAICompatibleModel implements ChatModel {
  readonly label: string;
  readonly vision: boolean;
  private readonly messages: Message[];
  private readonly base: string;

  constructor(
    private readonly settings: ModelSettings,
    system: string,
    private readonly tools: ToolSpec[],
    private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
  ) {
    this.label = settings.model;
    this.vision = settings.vision ?? false;
    this.base = (settings.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
    this.messages = [{ role: "system", content: system }];
  }

  sendUser(text: string, signal?: AbortSignal) {
    this.messages.push({ role: "user", content: text });
    return this.run(signal);
  }

  sendToolResults(results: ToolResult[], signal?: AbortSignal) {
    for (const r of results) {
      this.messages.push({
        role: "tool",
        tool_call_id: r.id,
        content: r.isError ? `ERROR: ${r.content}` : r.content || "(empty)",
      });
    }
    // Tool messages carry text only; screenshots follow as one user message.
    const images = this.vision ? results.filter((r) => r.image) : [];
    if (images.length > 0) {
      this.messages.push({
        role: "user",
        content: [
          { type: "text", text: "Screenshot of the current page (from the screenshot tool)." },
          ...images.flatMap((r): ContentPart[] =>
            r.image
              ? [
                  {
                    type: "image_url",
                    image_url: { url: `data:${r.image.mediaType};base64,${r.image.data}` },
                  },
                ]
              : [],
          ),
        ],
      });
    }
    return this.run(signal);
  }

  private async run(signal?: AbortSignal): Promise<ModelTurn> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.settings.apiKey) headers.authorization = `Bearer ${this.settings.apiKey}`;
    const res = await this.fetchFn(`${this.base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.settings.model,
        messages: this.messages,
        // Some servers reject an empty tools list, so one-shot requests send none.
        ...(this.tools.length
          ? {
              tools: this.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: "auto",
            }
          : {}),
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new ProviderError(await errorText(res), res.status);
    const body = (await res.json()) as {
      choices?: {
        finish_reason?: string;
        message?: { content?: string | null; tool_calls?: WireToolCall[] };
      }[];
    };
    const choice = body.choices?.[0];
    const msg = choice?.message ?? {};
    const calls = msg.tool_calls ?? [];
    this.messages.push({
      role: "assistant",
      content: msg.content ?? null,
      ...(calls.length ? { tool_calls: calls } : {}),
    });
    const toolCalls = calls.map((c) => ({
      id: c.id,
      name: c.function.name,
      input: parseArgs(c.function.arguments),
    }));
    return {
      text: (msg.content ?? "").trim(),
      toolCalls,
      stop:
        toolCalls.length > 0
          ? "tool_use"
          : choice?.finish_reason === "length"
            ? "max_tokens"
            : choice?.finish_reason === "content_filter"
              ? "refusal"
              : "end",
    };
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
