import { appOrigin, authSecret } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";
import { pkceChallenge, sign, verify } from "@/lib/tokens";

const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;

const err = (error: string, status = 400) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

async function issue(origin: string, clientId: string) {
  const secret = authSecret();
  return Response.json(
    {
      access_token: await sign(
        secret,
        "access",
        { aud: `${origin}/api/mcp`, cid: clientId.slice(-16) },
        ACCESS_TTL,
      ),
      refresh_token: await sign(secret, "refresh", { cid: clientId.slice(-16) }, REFRESH_TTL),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      scope: "scrapers",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return err("invalid_request");
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const secret = authSecret();
  const origin = appOrigin(req);
  const clientId = get("client_id");

  if (get("grant_type") === "authorization_code") {
    const code = await verify<{
      cid: string;
      redirect_uri: string;
      challenge: string;
      jti?: string;
    }>(secret, "code", get("code"));
    if (!code) return err("invalid_grant");
    if (code.cid !== clientId.slice(-16) || code.redirect_uri !== get("redirect_uri"))
      return err("invalid_grant");
    if (pkceChallenge(get("code_verifier")) !== code.challenge) return err("invalid_grant");
    // Codes are single-use: the first exchange claims the code's id.
    const rt = await getRuntime();
    if (!code.jti || !(await rt.scrapers.claimOnce(`oauth-code:${code.jti}`, 10 * 60_000))) {
      return err("invalid_grant");
    }
    return issue(origin, clientId);
  }

  if (get("grant_type") === "refresh_token") {
    const refresh = await verify<{ cid: string }>(secret, "refresh", get("refresh_token"));
    if (!refresh || (clientId && refresh.cid !== clientId.slice(-16))) return err("invalid_grant");
    return issue(origin, clientId || refresh.cid);
  }

  return err("unsupported_grant_type");
}
