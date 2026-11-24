import { isEngineWorker } from "@/lib/engine-auth";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";

/** The home worker asks what to read next (or how long to wait). Also its heartbeat. */
export async function POST(req: Request) {
  if (!isEngineWorker(req)) return new Response("not found", { status: 404 });
  const rt = await getRuntime();
  return Response.json(await rt.scrapers.engineNext());
}
