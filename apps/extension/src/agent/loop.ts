import type { ChatModel, ToolCall, ToolResult } from "../providers/types.js";
import { PAGE_ACTIONS } from "./tools.js";

export type AgentEvent =
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "status"; text: string };

export type AgentStatus = "done" | "stopped" | "max_steps" | "refusal" | "max_tokens" | "error";

export interface AgentRun {
  status: AgentStatus;
  summary: string;
  steps: number;
}

export interface AgentOptions {
  model: ChatModel;
  /** Runs one tool call in the browser or against the platform. */
  execute: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>;
  /** Model turns allowed before the run stops. */
  maxSteps?: number;
  /** Minimum milliseconds between page actions (click, type, scroll, navigate, back). */
  paceMs?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The agent loop: send the task, run every tool call the model asks for,
 * return all results in one turn, repeat until the model is done, the owner
 * presses stop, or the step limit is reached.
 */
export async function runAgent(task: string, opts: AgentOptions): Promise<AgentRun> {
  const maxSteps = opts.maxSteps ?? 25;
  const paceMs = opts.paceMs ?? 0;
  const signal = opts.signal ?? new AbortController().signal;
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const emit = (e: AgentEvent) => opts.onEvent?.(e);
  let lastAction = Number.NEGATIVE_INFINITY;
  let steps = 0;

  try {
    let turn = await opts.model.sendUser(task, signal);
    while (true) {
      steps++;
      if (turn.text) emit({ type: "assistant", text: turn.text });
      if (turn.stop === "refusal")
        return { status: "refusal", summary: turn.text || "رفض النموذج هذا الطلب.", steps };
      if (turn.stop === "max_tokens" && turn.toolCalls.length === 0)
        return { status: "max_tokens", summary: turn.text, steps };
      if (turn.toolCalls.length === 0) return { status: "done", summary: turn.text, steps };

      const done = turn.toolCalls.find((c) => c.name === "done");
      if (done) {
        const summary = String(done.input.summary ?? turn.text ?? "");
        emit({ type: "assistant", text: summary });
        return { status: "done", summary, steps };
      }
      if (steps >= maxSteps)
        return {
          status: "max_steps",
          summary: `توقفت بعد ${maxSteps} خطوة (الحد في الإعدادات).`,
          steps,
        };

      const results: ToolResult[] = [];
      for (const call of turn.toolCalls) {
        if (signal.aborted) throw signal.reason;
        if (PAGE_ACTIONS.has(call.name) && paceMs > 0) {
          const wait = lastAction + paceMs - now();
          if (wait > 0) {
            emit({ type: "status", text: `انتظار ${Math.ceil(wait / 1000)} ث قبل الخطوة التالية` });
            await sleep(wait, signal);
          }
          lastAction = now();
        }
        emit({ type: "tool", name: call.name, input: call.input });
        let result: ToolResult;
        try {
          result = await opts.execute(call, signal);
        } catch (err) {
          if (signal.aborted) throw signal.reason;
          result = { id: call.id, name: call.name, content: (err as Error).message, isError: true };
        }
        emit({
          type: "tool_result",
          name: call.name,
          ok: !result.isError,
          summary: result.content.slice(0, 160),
        });
        results.push(result);
      }
      turn = await opts.model.sendToolResults(results, signal);
    }
  } catch (err) {
    if (signal.aborted) return { status: "stopped", summary: "أوقفتَ المهمة.", steps };
    return { status: "error", summary: (err as Error).message, steps };
  }
}
