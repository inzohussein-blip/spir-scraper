import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The relay between the platform and the owner's reverse-api-engineer bridge
 * through a free ntfy topic (claude.ai → platform MCP → ntfy → bridge).
 *
 * The bridge uses Python's standard library only, which has no AES, so the
 * messages are sealed with HMAC-SHA256 in counter mode (the keystream) and an
 * HMAC-SHA256 tag over nonce and ciphertext (encrypt-then-MAC). The same
 * construction is in services/ig-worker/rae_bridge.py.
 */

const h = (label: string, secret: string) =>
  createHash("sha256").update(`${label}:${secret}`).digest();

/** Everything both sides derive from the one shared secret (RAE_RELAY_SECRET). */
export function relayKeys(secret: string) {
  if (secret.length < 24) throw new Error("RAE_RELAY_SECRET must be at least 24 characters");
  return {
    enc: h("rae-relay-enc", secret),
    mac: h("rae-relay-mac", secret),
    /** The ntfy topic: unguessable, and not the secret itself. */
    topic: `spir-rae-${h("rae-relay-topic", secret).toString("hex").slice(0, 32)}`,
    /** What the bridge sends back to the platform as its bearer token. */
    token: h("rae-relay-token", secret).toString("hex"),
  };
}
type Keys = ReturnType<typeof relayKeys>;

function keystream(key: Buffer, nonce: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0, block = 0; i < length; block++) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(block);
    const chunk = createHmac("sha256", key).update(nonce).update(counter).digest();
    chunk.copy(out, i, 0, Math.min(32, length - i));
    i += 32;
  }
  return out;
}

/** Encrypts and authenticates a JSON value: base64url(nonce 16 | tag 32 | ciphertext). */
export function sealRelay(keys: Keys, value: unknown): string {
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  const nonce = randomBytes(16);
  const stream = keystream(keys.enc, nonce, plain.length);
  const ct = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) ct[i] = (plain[i] as number) ^ (stream[i] as number);
  const tag = createHmac("sha256", keys.mac).update(nonce).update(ct).digest();
  return Buffer.concat([nonce, tag, ct]).toString("base64url");
}

/** The JSON value back, or null if it was not sealed with these keys or was altered. */
export function openRelay<T = unknown>(keys: Keys, sealed: string): T | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(sealed.trim(), "base64url");
  } catch {
    return null;
  }
  if (raw.length < 48) return null;
  const nonce = raw.subarray(0, 16);
  const tag = raw.subarray(16, 48);
  const ct = raw.subarray(48);
  const want = createHmac("sha256", keys.mac).update(nonce).update(ct).digest();
  if (!timingSafeEqual(tag, want)) return null;
  const stream = keystream(keys.enc, nonce, ct.length);
  const plain = Buffer.alloc(ct.length);
  for (let i = 0; i < ct.length; i++) plain[i] = (ct[i] as number) ^ (stream[i] as number);
  try {
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Sites the bridge refuses (the same list as the bridge itself). */
export const RELAY_BLOCKED_HOSTS = [
  "instagram.com",
  "cdninstagram.com",
  "tiktok.com",
  "facebook.com",
  "fb.com",
  "messenger.com",
  "threads.net",
  "threads.com",
  "whatsapp.com",
] as const;

/** An http(s) address that is not one of the refused sites, or an Arabic reason. */
export function checkRelayUrl(input: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { error: "ضع رابطاً يبدأ بـ https://" };
  }
  if (!/^https?:$/.test(u.protocol)) return { error: "ضع رابطاً يبدأ بـ https://" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const blocked = RELAY_BLOCKED_HOSTS.find((b) => host === b || host.endsWith(`.${b}`));
  if (blocked) return { error: `${blocked} غير مسموح: واجهاته الداخلية ليست للاستعمال دون إذنه.` };
  return { url: u.toString() };
}
