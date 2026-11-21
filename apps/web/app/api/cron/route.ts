import { isCronRequest } from "@/lib/drain";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Vercel Cron: daily retention, AI batch collection and a drain safety net. */
export async function GET(req: Request) {
  if (!isCronRequest(req)) return new Response("unauthorized", { status: 401 });
  const rt = await getRuntime();
  await rt.scrapers.handlers.retention();
  const health = await rt
    .healthCheck()
    .catch((err) => [{ provider: "all", ok: false, detail: String(err) }]);
  const drained = await rt.scrapers.drain({ budgetMs: 200_000 });
  return Response.json({ ok: true, ...drained, health });
}
