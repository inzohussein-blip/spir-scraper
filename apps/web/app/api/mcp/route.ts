import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildMcpServer } from "@scrapers/mcp";
import { scheduleDrain } from "@/lib/drain";
import { authorizeMcp } from "@/lib/mcp-auth";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

const handler = createMcpHandler(async () =>
  buildMcpServer(await getRuntime(), { onJobStarted: () => scheduleDrain() }),
);

async function handle(req: Request) {
  const auth = await authorizeMcp(req);
  if (!auth.ok) return auth.response;
  const res = await handler.fetch(req);
  // Keep queued jobs moving while Claude is polling get_job.
  scheduleDrain(new URL(req.url).origin);
  return res;
}

export { handle as DELETE, handle as GET, handle as POST };
