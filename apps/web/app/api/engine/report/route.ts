import type { EngineReport, RawProfile } from "@scrapers/core";
import { scheduleDrain } from "@/lib/drain";
import { isEngineWorker } from "@/lib/engine-auth";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 60;

const STATUSES = new Set(["ok", "not_found", "rate_limited", "blocked", "error"]);

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
export async function POST(req: Request) {
  if (!isEngineWorker(req)) return new Response("not found", { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const itemId = typeof body?.itemId === "string" ? body.itemId : null;
  const status = typeof body?.status === "string" ? body.status : null;
  if (!itemId || !status || !STATUSES.has(status))
    return Response.json({ error: "bad report" }, { status: 400 });
  let report: EngineReport;
  if (status === "ok") {
    const profile = asProfile(body?.profile);
    if (!profile) return Response.json({ error: "bad profile" }, { status: 400 });
    report = { itemId, status, profile };
  } else {
    report = {
      itemId,
      status: status as "not_found" | "rate_limited" | "blocked" | "error",
      ...(typeof body?.message === "string" ? { message: body.message.slice(0, 300) } : {}),
    };
  }
  const rt = await getRuntime();
  const decision = await rt.scrapers.engineReport(report);
  // Accepted accounts may have become a project job: read them now.
  scheduleDrain({ origin: new URL(req.url).origin, force: true, routeMaxSeconds: maxDuration });
  return Response.json(decision);
}
