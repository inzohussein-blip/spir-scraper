import { authSecret } from "@/lib/env";
import { isAllowedRedirect, sign } from "@/lib/tokens";

/**
 * Dynamic client registration (RFC 7591), stateless: the client id is a
 * signed token holding the client's redirect URIs.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    redirect_uris?: unknown;
    client_name?: unknown;
  };
  const uris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (uris.length === 0 || uris.length > 10 || !uris.every(isAllowedRedirect)) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "MCP client";
  const clientId = await sign(
    authSecret(),
    "client",
    { redirect_uris: uris, name },
    365 * 24 * 3600,
  );
  return Response.json(
    {
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201 },
  );
}
