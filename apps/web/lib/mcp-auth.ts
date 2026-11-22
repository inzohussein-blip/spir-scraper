import "server-only";
import { appOrigin, authSecret } from "./env";
import { getRuntime } from "./runtime";
import { verify } from "./tokens";

/** Accepts an API key (sk_...) or an OAuth access token issued by /api/oauth/token. */
export async function authorizeMcp(
  req: Request,
): Promise<{ ok: true; scopes: string[] } | { ok: false; response: Response }> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const rt = await getRuntime();
  let who: { id: string; scopes: string[] } | null = null;
  if (token.startsWith("sk_")) {
    const key = await rt.scrapers.verifyApiKey(token);
    if (key) who = { id: `key:${key.id}`, scopes: key.scopes };
  } else if (token) {
    const access = await verify<{ cid?: string; aud?: string }>(authSecret(), "access", token);
    // Tokens are issued for this deployment's MCP endpoint only.
    if (access && access.aud === `${appOrigin(req)}/api/mcp`)
      who = { id: `oauth:${access.cid ?? "client"}`, scopes: ["read", "write"] };
  }
  if (who) {
    const limit = Number(process.env.MCP_RATE_PER_MINUTE ?? 120);
    if ((await rt.scrapers.hitCounter(`mcp:${who.id}`, 60_000)) > limit) {
      return {
        ok: false,
        response: Response.json(
          { error: "rate_limited" },
          { status: 429, headers: { "retry-after": "60" } },
        ),
      };
    }
    return { ok: true, scopes: who.scopes };
  }
  const origin = appOrigin(req);
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    }),
  };
}
