import { createApi } from "@scrapers/api";
import { scheduleDrain } from "@/lib/drain";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

const api = createApi(getRuntime, { onJobStarted: () => scheduleDrain({ force: true }) });

/** Mounted at /api: strip the prefix so the Hono app sees /v1/... */
function handle(req: Request) {
  const url = new URL(req.url);
  url.pathname = url.pathname.replace(/^\/api/, "");
  return api.fetch(new Request(url, req));
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
