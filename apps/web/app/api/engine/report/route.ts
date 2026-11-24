import type { EngineReport, RawProfile } from "@scrapers/core";
import { scheduleDrain } from "@/lib/drain";
import { forWorker, isEngineWorker, workerInfo } from "@/lib/engine-auth";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 60;

const STATUSES = new Set(["ok", "not_found", "rate_limited", "blocked", "error", "released"]);

/** Checks the shape of a profile the worker read (it is stored as is). */
function asProfile(v: unknown): RawProfile | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (typeof p.igUserId !== "string" || typeof p.username !== "string") return null;
  if (!/^[a-z0-9._]{1,30}$/i.test(p.username)) return null;
  return {
    ...(p as unknown as RawProfile),
    isBusiness: p.isBusiness === true,
    isVerified: p.isVerified === true,
  };
}

/** The home worker reports one account it read; the answer is what to do next. */
/** One report as the worker sent it, checked field by field (null when malformed). */
function parseReport(body: Record<string, unknown>): EngineReport | null {
  const itemId = typeof body.itemId === "string" ? body.itemId : null;
  const status = typeof body.status === "string" ? body.status : null;
  if (!itemId || !status || !STATUSES.has(status)) return null;
  const exitId = typeof body.exitId === "string" ? body.exitId.slice(0, 64) : null;
  if (status === "ok") {
    const profile = asProfile(body.profile);
    return profile ? { itemId, status, profile, exitId } : null;
  }
  return {
    itemId,
    status: status as "not_found" | "rate_limited" | "blocked" | "error" | "released",
    exitId,
    ...(typeof body.message === "string" ? { message: body.message.slice(0, 300) } : {}),
  };
}

/**
 * A worker reports what it read: one account, or a whole batch as
 * { reports: [...] }. The answer is what to do next.
 */
export async function POST(req: Request) {
  if (!(await isEngineWorker(req))) return new Response("not found", { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "bad report" }, { status: 400 });
  const raw = Array.isArray(body.reports) ? body.reports.slice(0, 200) : [body];
  const reports = raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map(parseReport);
  if (reports.length === 0 || reports.some((r) => r === null))
    return Response.json({ error: "bad report" }, { status: 400 });
  const rt = await getRuntime();
  const decision = await rt.scrapers.engineReport(
    reports as EngineReport[],
    new Date(),
    workerInfo(body.worker),
  );
  // Accounts went to a project: read them now (otherwise nothing wakes up for nothing).
  if (decision.sent)
    scheduleDrain({ origin: new URL(req.url).origin, force: true, routeMaxSeconds: maxDuration });
  return Response.json(forWorker(decision));
}
