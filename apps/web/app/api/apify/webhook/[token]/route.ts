import { apifyWebhookToken } from "@scrapers/runtime";
import { scheduleDrain } from "@/lib/drain";
import { meter } from "@/lib/meter";
import { getRuntime } from "@/lib/runtime";
import { safeEqual } from "@/lib/tokens";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Apify calls this when a background run (a large followers or hashtag list)
 * ends. The address is the secret; the body is only a hint: the run is read
 * back from Apify with our own token, and only runs this app started count.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!process.env.AUTH_SECRET || !safeEqual(token, apifyWebhookToken()))
    return new Response("not found", { status: 404 });
  const body = (await req.json().catch(() => ({}))) as {
    resource?: { id?: string };
    eventData?: { actorRunId?: string };
  };
  const runId = body.resource?.id ?? body.eventData?.actorRunId;
  if (!runId) return Response.json({ ok: false }, { status: 400 });
  meter("webhooks");
  const rt = await getRuntime();
  const finished = await rt.scrapers.collectDiscoveryRuns(runId);
  // The accounts found are now queued: start reading them.
  if (finished > 0)
    scheduleDrain({ origin: new URL(req.url).origin, force: true, routeMaxSeconds: maxDuration });
  return Response.json({ ok: true, finished });
}
