import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM key for stored proxy addresses, derived from AUTH_SECRET. */
function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHash("sha256").update(`engine-proxies:${secret}`).digest();
}

/** Encrypts a secret value (a proxy address with its password) for the database. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

/** The value back, or null if it was sealed with another AUTH_SECRET or altered. */
export function open(sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** "http://user:pass@proxy.example:8000" → "proxy.example:8000" (never shows the password). */
export function proxyLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "proxy";
  }
}
