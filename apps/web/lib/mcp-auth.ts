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
  if (token.startsWith("sk_")) {
    const key = await (await getRuntime()).scrapers.verifyApiKey(token);
    if (key) return { ok: true, scopes: key.scopes };
  } else if (token) {
    const access = await verify<{ aud?: string }>(authSecret(), "access", token);
    if (access) return { ok: true, scopes: ["read", "write"] };
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
