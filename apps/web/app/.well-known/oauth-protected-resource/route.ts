import { appOrigin } from "@/lib/env";

export function GET(req: Request) {
  const origin = appOrigin(req);
  return Response.json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["scrapers"],
  });
}
