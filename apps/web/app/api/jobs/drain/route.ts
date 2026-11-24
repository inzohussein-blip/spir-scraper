import { isCronRequest, scheduleDrain } from "@/lib/drain";
import { meter } from "@/lib/meter";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Continues processing queued jobs in a fresh function call (see lib/drain.ts). */
export function POST(req: Request) {
  if (!isCronRequest(req)) return new Response("unauthorized", { status: 401 });
  meter("queue");
  scheduleDrain({ origin: new URL(req.url).origin, force: true });
  return Response.json({ accepted: true }, { status: 202 });
}
