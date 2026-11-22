import { createHash, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

/**
 * Stateless signed tokens (HS256) for the dashboard session and the OAuth
 * flow claude.ai uses to connect. Rotating AUTH_SECRET revokes all of them.
 */
export type TokenType = "session" | "login" | "client" | "code" | "access" | "refresh";

const ISSUER = "scrapers";

export async function sign(
  secret: Uint8Array,
  typ: TokenType,
  claims: Record<string, unknown>,
  ttlSeconds: number,
) {
  return new SignJWT({ ...claims, typ })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function verify<T extends Record<string, unknown>>(
  secret: Uint8Array,
  typ: TokenType,
  token: string,
) {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ["HS256"] });
    return payload.typ === typ ? (payload as T & { exp: number }) : null;
  } catch {
    return null;
  }
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** PKCE S256: base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Redirect URIs allowed for OAuth clients: https, or http on localhost. */
export function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/** Same-site paths only: "//host" and "/\host" are read by browsers as other sites. */
export function safeNext(next: string): string {
  const unsafe =
    !next.startsWith("/") ||
    next[1] === "/" ||
    next.includes("\\") ||
    [...next].some((ch) => ch.charCodeAt(0) < 0x20);
  return unsafe ? "/" : next;
}

/** Shortest dashboard password accepted; logins are also locked after repeated wrong tries. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * What is wrong with the DASHBOARD_PASSWORD setting, in Arabic for the login
 * page, or null when it is usable. The owner sees this instead of a server error.
 */
export function dashboardPasswordProblem(value: string | undefined): string | null {
  if (!value)
    return "كلمة مرور اللوحة غير مضبوطة. أضف DASHBOARD_PASSWORD في Vercel ثم أعد النشر (Redeploy).";
  if (value.length < MIN_PASSWORD_LENGTH)
    return `كلمة مرور اللوحة في Vercel أقصر من ${MIN_PASSWORD_LENGTH} أحرف. عدّل DASHBOARD_PASSWORD ثم أعد النشر (Redeploy).`;
  return null;
}
