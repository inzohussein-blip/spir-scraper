/**
 * One interface over every AI provider. Each adapter keeps the conversation
 * in its provider's own format, so provider-specific blocks (Claude's thinking
 * blocks, Gemini's thought signatures) are sent back exactly as received.
 */

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  /** Text for the model. */
  content: string;
  /** Optional screenshot, sent to providers that accept images. */
  image?: { mediaType: "image/png" | "image/jpeg"; data: string };
  isError?: boolean;
}

export type StopReason = "tool_use" | "end" | "max_tokens" | "refusal";

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
}

export interface ChatModel {
  readonly label: string;
  /** Whether screenshots can be sent with tool results. */
  readonly vision: boolean;
  /** Sends the user's message (first turn or a follow-up). */
  sendUser(text: string, signal?: AbortSignal): Promise<ModelTurn>;
  /** Sends results for every tool call of the previous turn. */
  sendToolResults(results: ToolResult[], signal?: AbortSignal): Promise<ModelTurn>;
}

export type ProviderKind = "anthropic" | "openai" | "gemini";

export interface ModelSettings {
  provider: ProviderKind;
  model: string;
  apiKey: string;
  /** OpenAI-compatible servers (OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio). */
  baseUrl?: string;
  /** Send screenshots (the model must accept images). */
  vision?: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Reads an error body without throwing, trimmed for display. */
export async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const msg = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
    if (msg) return `${res.status}: ${msg}`.slice(0, 500);
  } catch {
    // not JSON
  }
  return `${res.status}: ${body || res.statusText}`.slice(0, 500);
}
