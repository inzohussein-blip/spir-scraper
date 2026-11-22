import "server-only";
import { after } from "next/server";
import { appOrigin } from "./env";
import { getRuntime } from "./runtime";
import { safeEqual } from "./tokens";

/** Seconds a drain may run inside one function call (keep under the route's maxDuration). */
const BUDGET_MS = Number(process.env.DRAIN_BUDGET_SECONDS ?? 240) * 1000;

/** After a drain finds nothing to do, routine nudges are skipped this long. */
const IDLE_SKIP_MS = 60_000;

let running = false;
let idleUntil = 0;

/**
 * Vercel has no always-on worker, so queued jobs are processed after
 * responses (next/server `after`) and the drain hands itself on to a fresh
 * function call while work remains. A daily cron is the safety net.
 *
 * Routine nudges (every MCP request, an open job page) are skipped for a
 * minute after a drain found no work, so an idle dashboard costs no extra
 * database round trips. `force` (a job was just started, the chain, the cron)
 * always drains.
 */
export function scheduleDrain(opts: { origin?: string; force?: boolean } = {}) {
  if (!opts.force && Date.now() < idleUntil) return;
  after(async () => {
    if (running) return;
    running = true;
    try {
      const rt = await getRuntime();
      const r = await rt.scrapers.drain({ budgetMs: BUDGET_MS });
      idleUntil = r.processed === 0 && r.activeJobs === 0 ? Date.now() + IDLE_SKIP_MS : 0;
      if (r.more) await chain(opts.origin ?? appOrigin());
    } catch (err) {
      console.error("[drain]", err);
    } finally {
      running = false;
    }
  });
}

/** Asks a new function call to continue draining. Returns as soon as it is accepted. */
async function chain(origin: string) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  await fetch(`${origin}/api/jobs/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => console.error("[drain] chain failed", err));
}

export function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}
