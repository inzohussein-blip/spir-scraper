import { isCronRequest } from "@/lib/drain";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Vercel Cron (daily on the Hobby plan): retention, AI batch collection,
 * provider checks, due competitor monitors, follow-up reminders, the weekly summary, and a drain
 * safety net for anything left in the queue.
 */
export async function GET(req: Request) {
  if (!isCronRequest(req)) return new Response("unauthorized", { status: 401 });
  const rt = await getRuntime();
  await rt.scrapers.handlers.retention();
  const health = await rt
    .healthCheck()
    .catch((err) => [{ provider: "all", ok: false, detail: String(err) }]);
  const monitorJobs = await rt.scrapers.runDueMonitors();
  const followUps = await rt.scrapers.sendDueFollowUps().catch(() => 0);
  const weekly = await rt.scrapers.weeklySummary().catch(() => null);
  const drained = await rt.scrapers.drain({ budgetMs: 180_000 });
  await rt.scrapers.setValue("cron:last", new Date().toISOString(), 30 * 86_400_000);
  return Response.json({
    ok: true,
    ...drained,
    health,
    monitorJobs,
    followUps,
    weeklySent: !!weekly,
  });
}
