import { randomUUID, timingSafeEqual } from "node:crypto";
import { checkRelayUrl, openRelay, relayKeys, sealRelay } from "../../rae-relay.js";
import type { Core } from "../core.js";
import type { CoreSelf } from "./context.js";

/** How long a relayed run and its result are kept (the ephemeral store). */
const KEEP_MS = 24 * 3600_000;
/** The most file text one result may carry back. */
const MAX_FILES_CHARS = 400_000;

export type RelayFile = { name: string; content: string | null };
export type RelayJob = {
  id: string;
  kind: "agent" | "engineer";
  url?: string;
  run_id?: string;
  prompt: string;
  status: "sent" | "accepted" | "done" | "failed";
  sentAt: number;
  updatedAt: number;
  result?: Record<string, unknown> | null;
  files?: RelayFile[];
  error?: string | null;
};

const MODEL = /^[\w./:@+-]{1,120}$/;
const RUN_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * reverse-api-engineer through claude.ai: the platform's MCP tools send a
 * sealed request to the owner's bridge through a free ntfy topic, and the
 * bridge reports back once when it accepts and once when it ends. The bridge
 * never asks the platform anything, so waiting costs nothing.
 */
export function relayMethods(core: Core, _api: () => CoreSelf) {
  const { deps, getValue, setValue } = core;
  const relay = deps.relay;
  const keys = relay ? relayKeys(relay.secret) : null;
  const key = (id: string) => `rae:job:${id}`;

  async function send(job: RelayJob, message: Record<string, unknown>) {
    if (!relay || !keys)
      throw new Error("الربط عبر ntfy غير مفعّل: أضف RAE_RELAY_SECRET في Vercel.");
    await setValue(key(job.id), job, KEEP_MS);
    await relay.publish(sealRelay(keys, { v: 1, id: job.id, at: Date.now(), ...message }));
    return {
      job_id: job.id,
      status: job.status,
      next: "اسأل rae_relay_result بعد دقيقتين أو ثلاث (التشغيل يأخذ عادة بضع دقائق على جهاز المالك).",
    };
  }

  return {
    /** Whether RAE_RELAY_SECRET is set (the relay can be used). */
    get raeRelayAvailable() {
      return !!relay;
    },

    /** Asks the owner's bridge to capture a site and write its API client. */
    async raeRelayStart(input: {
      url: string;
      prompt: string;
      headless?: boolean;
      model?: string;
    }) {
      const checked = checkRelayUrl(input.url);
      if ("error" in checked) throw new Error(checked.error);
      const prompt = input.prompt.trim();
      if (!prompt || prompt.length > 2000) throw new Error("اكتب الهدف (حتى 2000 حرف).");
      if (input.model && !MODEL.test(input.model)) throw new Error("اسم النموذج غير صالح.");
      const now = Date.now();
      const job: RelayJob = {
        id: randomUUID(),
        kind: "agent",
        url: checked.url,
        prompt,
        status: "sent",
        sentAt: now,
        updatedAt: now,
      };
      return send(job, {
        kind: "agent",
        url: checked.url,
        prompt,
        headless: input.headless ?? true,
        ...(input.model ? { model: input.model } : {}),
      });
    },

    /** Asks the bridge to improve a past run's client from its saved capture. */
    async raeRelayEngineer(input: { run_id: string; prompt?: string; fresh?: boolean }) {
      if (!RUN_ID.test(input.run_id)) throw new Error("معرّف التشغيل غير صالح.");
      const now = Date.now();
      const job: RelayJob = {
        id: randomUUID(),
        kind: "engineer",
        run_id: input.run_id,
        prompt: (input.prompt ?? "").trim().slice(0, 2000),
        status: "sent",
        sentAt: now,
        updatedAt: now,
      };
      return send(job, {
        kind: "engineer",
        run_id: input.run_id,
        prompt: job.prompt,
        fresh: !!input.fresh,
      });
    },

    /**
     * A report from the bridge (sealed with the shared keys). Returns false
     * when the token or the seal is wrong, or the run is unknown.
     */
    async raeRelayReport(token: string, sealed: string): Promise<boolean> {
      if (!keys) return false;
      const a = Buffer.from(token);
      const b = Buffer.from(keys.token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      const msg = openRelay<{
        id?: string;
        status?: string;
        result?: Record<string, unknown> | null;
        files?: RelayFile[];
        error?: string | null;
      }>(keys, sealed);
      if (!msg?.id || !["accepted", "done", "failed"].includes(msg.status ?? "")) return false;
      const job = await getValue<RelayJob>(key(msg.id));
      if (!job) return false;
      let budget = MAX_FILES_CHARS;
      const files = (msg.files ?? []).slice(0, 40).map((f) => {
        const content =
          typeof f.content === "string" && f.content.length <= budget ? f.content : null;
        if (content) budget -= content.length;
        return { name: String(f.name).slice(0, 200), content };
      });
      await setValue(
        key(msg.id),
        {
          ...job,
          status: msg.status as RelayJob["status"],
          updatedAt: Date.now(),
          ...(msg.result !== undefined ? { result: msg.result } : {}),
          ...(msg.files ? { files } : {}),
          ...(msg.error !== undefined
            ? { error: String(msg.error ?? "").slice(0, 1000) || null }
            : {}),
        } satisfies RelayJob,
        KEEP_MS,
      );
      return true;
    },

    /** A relayed run's state and, once done, its generated files. */
    async raeRelayResult(id: string) {
      const job = await getValue<RelayJob>(key(id));
      if (!job) return null;
      const waiting = Date.now() - job.sentAt;
      return {
        ...job,
        hint:
          job.status === "sent" && waiting > 90_000
            ? "لم يستلم جهاز المالك الطلب بعد: الجسر غير مشغّل بخيار --relay، أو الجهاز مطفأ. سيُنفَّذ إن شُغّل الجسر خلال ساعة."
            : job.status === "accepted"
              ? "يعمل الآن على جهاز المالك. اسأل مرة أخرى بعد دقيقة أو اثنتين."
              : null,
      };
    },
  };
}
