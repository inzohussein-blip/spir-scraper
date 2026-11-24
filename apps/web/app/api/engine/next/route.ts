import { forWorker, isEngineWorker, workerInfo } from "@/lib/engine-auth";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";

/** A worker asks what to read next (or how long to wait). Also its heartbeat. */
export async function POST(req: Request) {
  if (!(await isEngineWorker(req))) return new Response("not found", { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { worker?: unknown };
  const rt = await getRuntime();
  return Response.json(
    forWorker(await rt.scrapers.engineNext(new Date(), workerInfo(body.worker))),
  );
}
