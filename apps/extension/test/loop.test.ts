import { describe, expect, it } from "vitest";
import { type AgentEvent, runAgent } from "../src/agent/loop.js";
import { systemPrompt, toolsFor } from "../src/agent/tools.js";
import type { ChatModel, ModelTurn, ToolResult } from "../src/providers/types.js";

class ScriptedModel implements ChatModel {
  readonly label = "fake";
  readonly vision = false;
  received: (string | ToolResult[])[] = [];
  constructor(private readonly turns: ModelTurn[]) {}
  async sendUser(text: string) {
    this.received.push(text);
    return this.next();
  }
  async sendToolResults(results: ToolResult[]) {
    this.received.push(results);
    return this.next();
  }
  private next(): ModelTurn {
    return this.turns.shift() ?? { text: "end", toolCalls: [], stop: "end" };
  }
}

const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  id,
  name,
  input,
});

describe("runAgent", () => {
  it("runs tools, returns every result of a turn together, and stops on done", async () => {
    const model = new ScriptedModel([
      {
        text: "أقرأ",
        toolCalls: [call("1", "read_page"), call("2", "click", { id: 4 })],
        stop: "tool_use",
      },
      { text: "", toolCalls: [call("3", "done", { summary: "حفظت 3 حسابات" })], stop: "tool_use" },
    ]);
    const executed: string[] = [];
    const events: AgentEvent[] = [];
    const run = await runAgent("المهمة", {
      model,
      execute: async (c) => {
        executed.push(c.name);
        return { id: c.id, name: c.name, content: `ok ${c.name}` };
      },
      onEvent: (e) => events.push(e),
    });
    expect(run).toEqual({ status: "done", summary: "حفظت 3 حسابات", steps: 2 });
    expect(executed).toEqual(["read_page", "click"]);
    expect(model.received[1]).toHaveLength(2);
    expect(
      events.filter((e) => e.type === "tool").map((e) => (e as { name: string }).name),
    ).toEqual(["read_page", "click"]);
  });

  it("spaces page actions by the pace setting but not reads", async () => {
    let t = 0;
    const slept: number[] = [];
    const model = new ScriptedModel([
      {
        text: "",
        toolCalls: [call("1", "click", { id: 1 }), call("2", "read_page"), call("3", "scroll")],
        stop: "tool_use",
      },
    ]);
    await runAgent("x", {
      model,
      paceMs: 3000,
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
      execute: async (c) => {
        t += 500;
        return { id: c.id, name: c.name, content: "" };
      },
    });
    // click at 0, read (no wait), scroll waits until 3000.
    expect(slept).toEqual([2000]);
  });

  it("turns tool errors into results the model can see", async () => {
    const model = new ScriptedModel([
      { text: "", toolCalls: [call("1", "navigate", { url: "x" })], stop: "tool_use" },
    ]);
    await runAgent("x", {
      model,
      execute: async () => {
        throw new Error("الموقع غير مسموح");
      },
    });
    expect(model.received[1]).toEqual([
      { id: "1", name: "navigate", content: "الموقع غير مسموح", isError: true },
    ]);
  });

  it("stops at the step limit, on refusal, and when the owner presses stop", async () => {
    const looping = new ScriptedModel(
      Array.from({ length: 10 }, (_, i) => ({
        text: "",
        toolCalls: [call(String(i), "read_page")],
        stop: "tool_use" as const,
      })),
    );
    const exec = async (c: { id: string; name: string }) => ({
      id: c.id,
      name: c.name,
      content: "",
    });
    expect((await runAgent("x", { model: looping, execute: exec, maxSteps: 3 })).status).toBe(
      "max_steps",
    );

    const refusing = new ScriptedModel([{ text: "لا", toolCalls: [], stop: "refusal" }]);
    expect(await runAgent("x", { model: refusing, execute: exec })).toMatchObject({
      status: "refusal",
      summary: "لا",
    });

    const ctrl = new AbortController();
    const stopping = new ScriptedModel([
      { text: "", toolCalls: [call("1", "read_page"), call("2", "click")], stop: "tool_use" },
    ]);
    const run = await runAgent("x", {
      model: stopping,
      signal: ctrl.signal,
      execute: async (c) => {
        ctrl.abort();
        return { id: c.id, name: c.name, content: "" };
      },
    });
    expect(run.status).toBe("stopped");
  });
});

describe("tool sets", () => {
  it("gives ask mode read-only tools and auto mode the actions", () => {
    const ask = toolsFor("ask", true).map((t) => t.name);
    expect(ask).toContain("read_page");
    expect(ask).not.toContain("click");
    expect(ask).not.toContain("platform_save");
    const auto = toolsFor("auto", false).map((t) => t.name);
    expect(auto).toEqual(
      expect.arrayContaining(["click", "type", "navigate", "platform_save", "done"]),
    );
    expect(auto).not.toContain("screenshot");
  });

  it("tells the model page content is untrusted", () => {
    expect(systemPrompt("auto")).toMatch(/untrusted/);
    expect(systemPrompt("ask")).toMatch(/cannot click/);
  });
});
