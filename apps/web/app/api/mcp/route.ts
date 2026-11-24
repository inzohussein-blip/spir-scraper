import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildMcpServer, SERVERLESS_MCP_OPTIONS } from "@scrapers/mcp";
import { scheduleDrain } from "@/lib/drain";
import { authorizeMcp } from "@/lib/mcp-auth";
import { meter } from "@/lib/meter";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
// Every MCP exchange is a short request/response; nothing here should run long.
export const maxDuration = 60;

const handler = createMcpHandler(
  async () =>
    buildMcpServer(await getRuntime(), {
      onJobStarted: () => scheduleDrain({ force: true, routeMaxSeconds: maxDuration }),
    }),
  SERVERLESS_MCP_OPTIONS,
);

async function handle(req: Request) {
  const auth = await authorizeMcp(req);
  if (!auth.ok) return auth.response;
  meter("mcp");
  const res = await handler.fetch(req);
  // Keep queued jobs moving while Claude is polling get_job.
  scheduleDrain({ origin: new URL(req.url).origin, routeMaxSeconds: maxDuration });
  return res;
}

export { handle as DELETE, handle as GET, handle as POST };
