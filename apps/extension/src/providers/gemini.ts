import type {
  ChatModel,
  FetchLike,
  ModelSettings,
  ModelTurn,
  ToolResult,
  ToolSpec,
} from "./types.js";
import { errorText, ProviderError } from "./types.js";

type Part =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown>; id?: string } }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } }
  | { inlineData: { mimeType: string; data: string } }
  | Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Gemini's function declarations accept a subset of JSON Schema. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

/** Google Gemini (generateContent). Model turns are sent back whole, thought signatures included. */
export class GeminiModel implements ChatModel {
  readonly label: string;
  readonly vision = true;
  private readonly contents: Content[] = [];

  constructor(
    private readonly settings: ModelSettings,
    private readonly system: string,
    private readonly tools: ToolSpec[],
    private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
  ) {
    this.label = settings.model;
  }

  sendUser(text: string, signal?: AbortSignal) {
    this.contents.push({ role: "user", parts: [{ text }] });
    return this.run(signal);
  }

  sendToolResults(results: ToolResult[], signal?: AbortSignal) {
    const parts: Part[] = [];
    for (const r of results) {
      parts.push({
        functionResponse: {
          name: r.name,
          ...(r.id.startsWith("gemini-") ? {} : { id: r.id }),
          response: r.isError ? { error: r.content } : { result: r.content },
        },
      });
      if (r.image) parts.push({ inlineData: { mimeType: r.image.mediaType, data: r.image.data } });
    }
    this.contents.push({ role: "user", parts });
    return this.run(signal);
  }

  private async run(signal?: AbortSignal): Promise<ModelTurn> {
    const res = await this.fetchFn(
      `${BASE}/models/${encodeURIComponent(this.settings.model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.settings.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: this.system }] },
          contents: this.contents,
          ...(this.tools.length
            ? {
                tools: [
                  {
                    functionDeclarations: this.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parameters: geminiSchema(t.parameters),
                    })),
                  },
                ],
              }
            : {}),
        }),
        ...(signal ? { signal } : {}),
      },
    );
    if (!res.ok) throw new ProviderError(await errorText(res), res.status);
    const body = (await res.json()) as {
      candidates?: { content?: Content; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    const cand = body.candidates?.[0];
    if (!cand?.content) {
      if (body.promptFeedback?.blockReason) return { text: "", toolCalls: [], stop: "refusal" };
      throw new ProviderError("Gemini returned no answer");
    }
    this.contents.push({ role: "model", parts: cand.content.parts ?? [] });

    const text: string[] = [];
    const toolCalls: ModelTurn["toolCalls"] = [];
    (cand.content.parts ?? []).forEach((p, i) => {
      if ("text" in p && typeof p.text === "string" && !("thought" in p && p.thought))
        text.push(p.text);
      if ("functionCall" in p && p.functionCall && typeof p.functionCall === "object") {
        const fc = p.functionCall as { name: string; args?: Record<string, unknown>; id?: string };
        toolCalls.push({ id: fc.id ?? `gemini-${i}`, name: fc.name, input: fc.args ?? {} });
      }
    });
    const reason = cand.finishReason ?? "";
    return {
      text: text.join("\n").trim(),
      toolCalls,
      stop:
        toolCalls.length > 0
          ? "tool_use"
          : reason === "MAX_TOKENS"
            ? "max_tokens"
            : reason === "SAFETY" || reason === "PROHIBITED_CONTENT"
              ? "refusal"
              : "end",
    };
  }
}
