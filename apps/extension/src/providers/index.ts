import { AnthropicModel } from "./anthropic.js";
import { GeminiModel } from "./gemini.js";
import { OpenAICompatibleModel } from "./openai.js";
import type { ChatModel, ModelSettings, ToolSpec } from "./types.js";

export * from "./anthropic.js";
export * from "./gemini.js";
export * from "./openai.js";
export * from "./types.js";

/** A fresh conversation with the configured provider. */
export function createModel(settings: ModelSettings, system: string, tools: ToolSpec[]): ChatModel {
  if (!settings.model) throw new Error("اختر اسم النموذج في الإعدادات");
  if (settings.provider === "anthropic") {
    if (!settings.apiKey) throw new Error("ضع مفتاح Claude في الإعدادات");
    return new AnthropicModel(settings, system, tools);
  }
  if (settings.provider === "gemini") {
    if (!settings.apiKey) throw new Error("ضع مفتاح Gemini في الإعدادات");
    return new GeminiModel(settings, system, tools);
  }
  return new OpenAICompatibleModel(settings, system, tools);
}
