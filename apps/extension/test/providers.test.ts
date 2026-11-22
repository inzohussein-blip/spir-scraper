import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicModel } from "../src/providers/anthropic.js";
import { GeminiModel } from "../src/providers/gemini.js";
import { createModel } from "../src/providers/index.js";
import { OpenAICompatibleModel } from "../src/providers/openai.js";
import type { ToolSpec } from "../src/providers/types.js";

const tools: ToolSpec[] = [
  {
    name: "click",
    description: "Click",
    parameters: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recorder(responses: unknown[]) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return json(responses.shift());
  };
  return { fn, calls };
}

describe("AnthropicModel", () => {
  const assistantTurn = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig-abc" },
      { type: "text", text: "أقرأ الصفحة" },
      { type: "tool_use", id: "tu_1", name: "click", input: { id: 3 } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const finalTurn = {
    ...assistantTurn,
    id: "msg_2",
    content: [{ type: "text", text: "تم" }],
    stop_reason: "end_turn",
  };

  it("sends tools, effort and the refusal fallback, and replays thinking blocks unchanged", async () => {
    const r = recorder([assistantTurn, finalTurn]);
    const client = new Anthropic({
      apiKey: "k",
      fetch: r.fn,
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
    });
    const m = new AnthropicModel(
      { provider: "anthropic", model: "claude-opus-5-5", apiKey: "k" },
      "SYS",
      tools,
      "low",
      client,
    );
    const t1 = await m.sendUser("اقرأ");
    expect(t1).toEqual({
      text: "أقرأ الصفحة",
      toolCalls: [{ id: "tu_1", name: "click", input: { id: 3 } }],
      stop: "tool_use",
    });
    const first = r.calls[0]!;
    expect(first.url).toContain("/v1/messages");
    expect(first.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(first.body).toMatchObject({
      model: "claude-opus-5-5",
      system: "SYS",
      fallbacks: "default",
      output_config: { effort: "low" },
      tools: [{ name: "click", input_schema: tools[0]!.parameters }],
    });

    const t2 = await m.sendToolResults([
      {
        id: "tu_1",
        name: "click",
        content: "clicked",
        image: { mediaType: "image/png", data: "AAA" },
      },
    ]);
    expect(t2.stop).toBe("end");
    const second = r.calls[1]!.body;
    // The assistant turn goes back exactly as received, thinking block first.
    expect(second.messages[1]).toEqual({ role: "assistant", content: assistantTurn.content });
    expect(second.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [
        { type: "text", text: "clicked" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      ],
    });
  });

  it("leaves fallbacks off for models without them and reports refusals", async () => {
    const r = recorder([{ ...finalTurn, content: [], stop_reason: "refusal" }]);
    const client = new Anthropic({
      apiKey: "k",
      fetch: r.fn,
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
    });
    const m = new AnthropicModel(
      { provider: "anthropic", model: "claude-haiku-5-5", apiKey: "k" },
      "SYS",
      tools,
      "medium",
      client,
    );
    expect((await m.sendUser("x")).stop).toBe("refusal");
    expect(r.calls[0]!.body.fallbacks).toBeUndefined();
    expect(r.calls[0]!.headers.get("anthropic-beta")).toBeNull();
  });
});

describe("OpenAICompatibleModel", () => {
  it("speaks chat completions with tool calls, tool messages and screenshots", async () => {
    const r = recorder([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "click", arguments: '{"id":7}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: "stop", message: { content: "انتهيت" } }] },
    ]);
    const m = new OpenAICompatibleModel(
      {
        provider: "openai",
        model: "m",
        apiKey: "sk",
        baseUrl: "https://openrouter.ai/api/v1/",
        vision: true,
      },
      "SYS",
      tools,
      r.fn,
    );
    expect(await m.sendUser("go")).toEqual({
      text: "",
      toolCalls: [{ id: "c1", name: "click", input: { id: 7 } }],
      stop: "tool_use",
    });
    expect(r.calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(r.calls[0]!.headers.get("authorization")).toBe("Bearer sk");
    expect(r.calls[0]!.body.tools[0]).toEqual({
      type: "function",
      function: { name: "click", description: "Click", parameters: tools[0]!.parameters },
    });
    const t2 = await m.sendToolResults([
      { id: "c1", name: "click", content: "ok", image: { mediaType: "image/png", data: "B" } },
    ]);
    expect(t2).toMatchObject({ text: "انتهيت", stop: "end" });
    const msgs = r.calls[1]!.body.messages;
    expect(msgs.at(-2)).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
    expect(msgs.at(-1).content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,B" },
    });
  });

  it("works without a key for local servers and surfaces HTTP errors", async () => {
    const calls: Headers[] = [];
    const m = new OpenAICompatibleModel(
      { provider: "openai", model: "llama", apiKey: "", baseUrl: "http://localhost:11434/v1" },
      "S",
      tools,
      async (_u, init) => {
        calls.push(new Headers(init?.headers));
        return json({ error: { message: "model not found" } }, 404);
      },
    );
    await expect(m.sendUser("x")).rejects.toThrow("404: model not found");
    expect(calls[0]!.get("authorization")).toBeNull();
  });
});

describe("GeminiModel", () => {
  it("sends function declarations without unsupported schema keys and replays model parts", async () => {
    const modelParts = [
      { functionCall: { name: "click", args: { id: 2 } }, thoughtSignature: "sig" },
    ];
    const r = recorder([
      { candidates: [{ content: { role: "model", parts: modelParts }, finishReason: "STOP" }] },
      {
        candidates: [{ content: { role: "model", parts: [{ text: "تم" }] }, finishReason: "STOP" }],
      },
    ]);
    const withExtra: ToolSpec[] = [
      {
        ...tools[0]!,
        parameters: { ...tools[0]!.parameters, additionalProperties: false } as never,
      },
    ];
    const m = new GeminiModel(
      { provider: "gemini", model: "gemini-x", apiKey: "g" },
      "SYS",
      withExtra,
      r.fn,
    );
    const t1 = await m.sendUser("go");
    expect(t1.toolCalls).toEqual([{ id: "gemini-0", name: "click", input: { id: 2 } }]);
    expect(r.calls[0]!.url).toContain("/models/gemini-x:generateContent");
    expect(r.calls[0]!.headers.get("x-goog-api-key")).toBe("g");
    expect(r.calls[0]!.body.tools[0].functionDeclarations[0].parameters).not.toHaveProperty(
      "additionalProperties",
    );
    await m.sendToolResults([{ id: "gemini-0", name: "click", content: "ok" }]);
    const contents = r.calls[1]!.body.contents;
    expect(contents[1]).toEqual({ role: "model", parts: modelParts });
    expect(contents[2].parts[0]).toEqual({
      functionResponse: { name: "click", response: { result: "ok" } },
    });
  });
});

describe("createModel", () => {
  it("asks for the missing settings in Arabic", () => {
    expect(() => createModel({ provider: "anthropic", model: "", apiKey: "" }, "", [])).toThrow(
      "اسم النموذج",
    );
    expect(() => createModel({ provider: "gemini", model: "g", apiKey: "" }, "", [])).toThrow(
      "مفتاح Gemini",
    );
  });
});
