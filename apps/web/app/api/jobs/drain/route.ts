import { isCronRequest, scheduleDrain } from "@/lib/drain";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Continues processing queued jobs in a fresh function call (see lib/drain.ts). */
export function POST(req: Request) {
  if (!isCronRequest(req)) return new Response("unauthorized", { status: 401 });
  scheduleDrain({ origin: new URL(req.url).origin, force: true });
  return Response.json({ accepted: true }, { status: 202 });
}
