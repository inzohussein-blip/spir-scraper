import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

/** Marks an encrypted backup file (format version 1). */
const SEALED_MAGIC = Buffer.from("SPIRBK1\n");

const backupKey = (secret: string) => createHash("sha256").update(`backup:${secret}`).digest();

/** Encrypts a backup (AES-256-GCM, key derived from the platform's AUTH_SECRET). */
export function sealBackup(bytes: Uint8Array, secret: string): Uint8Array {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", backupKey(secret), iv);
  const body = Buffer.concat([c.update(bytes), c.final()]);
  return new Uint8Array(Buffer.concat([SEALED_MAGIC, iv, c.getAuthTag(), body]));
}

/** The gzipped backup back, or null when the file is not one of ours or the secret differs. */
export function openBackup(sealed: Uint8Array, secret: string): Uint8Array | null {
  const buf = Buffer.from(sealed);
  if (!isSealedBackup(buf)) return null;
  const at = SEALED_MAGIC.length;
  try {
    const d = createDecipheriv("aes-256-gcm", backupKey(secret), buf.subarray(at, at + 12));
    d.setAuthTag(buf.subarray(at + 12, at + 28));
    return new Uint8Array(Buffer.concat([d.update(buf.subarray(at + 28)), d.final()]));
  } catch {
    return null;
  }
}

export function isSealedBackup(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, SEALED_MAGIC.length)).equals(SEALED_MAGIC);
}

/**
 * The JSON text of any backup file the platform makes: encrypted (.enc, from
 * Telegram), gzipped (.json.gz, the download) or plain .json. Throws an
 * Arabic message the owner can act on.
 */
export function readBackupFile(bytes: Uint8Array, secret: string): string {
  let data = bytes;
  if (isSealedBackup(data)) {
    const opened = openBackup(data, secret);
    if (!opened)
      throw new Error(
        "تعذّر فك التشفير: الملف ليس نسخة من هذه المنصة، أو تغيّر AUTH_SECRET منذ إنشائها.",
      );
    data = opened;
  }
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = new Uint8Array(gunzipSync(data));
    } catch {
      throw new Error("الملف المضغوط تالف.");
    }
  }
  return Buffer.from(data).toString("utf8");
}
