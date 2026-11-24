import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Runtime } from "@scrapers/runtime";

/** Telegram bots can send files up to 50 MB; keep a margin. */
export const TELEGRAM_MAX_BACKUP_BYTES = 45 * 1024 * 1024;

/**
 * A gzipped JSON copy of projects, leads, profiles, notes, monitors, the
 * do-not-contact list, partners, broker reports, own posts and messages.
 */
export async function buildBackup(rt: Runtime) {
  const data = await rt.scrapers.exportBackup();
  const gz = gzipSync(Buffer.from(JSON.stringify(data)));
  const day = data.createdAt.slice(0, 10);
  return {
    name: `spir-backup-${day}.json.gz`,
    bytes: new Uint8Array(gz),
    summary: `${data.projects.length} مشروع · ${data.leads.length} عميل · ${data.leadEvents.length} ملاحظة`,
  };
}

/** Secret part of the broker's postback address, derived from AUTH_SECRET. */
export function brokerToken(): string {
  return createHash("sha256")
    .update(`broker:${process.env.AUTH_SECRET ?? ""}`)
    .digest("hex")
    .slice(0, 40);
}

/** Private calendar address, derived from AUTH_SECRET (rotating it changes the address). */
export function calendarToken(): string {
  return createHash("sha256")
    .update(`calendar:${process.env.AUTH_SECRET ?? ""}`)
    .digest("hex")
    .slice(0, 40);
}

/** Verify token for the Meta webhook subscription, derived from AUTH_SECRET. */
export function metaVerifyToken(): string {
  return createHash("sha256")
    .update(`meta:${process.env.AUTH_SECRET ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

/** Marks an encrypted backup file (format version 1). */
const SEALED_MAGIC = Buffer.from("SPIRBK1\n");

function backupKey(): Buffer {
  return createHash("sha256")
    .update(`backup:${process.env.AUTH_SECRET ?? ""}`)
    .digest();
}

/**
 * Encrypts a backup (AES-256-GCM, key from AUTH_SECRET) before it leaves the
 * platform, e.g. to Telegram. Open it in Settings → «فك تشفير نسخة».
 */
export function sealBackup(bytes: Uint8Array): Uint8Array {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", backupKey(), iv);
  const body = Buffer.concat([c.update(bytes), c.final()]);
  return new Uint8Array(Buffer.concat([SEALED_MAGIC, iv, c.getAuthTag(), body]));
}

/** The gzipped backup back, or null when the file is not one of ours or AUTH_SECRET changed. */
export function openBackup(sealed: Uint8Array): Uint8Array | null {
  const buf = Buffer.from(sealed);
  if (!buf.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC)) return null;
  const at = SEALED_MAGIC.length;
  try {
    const d = createDecipheriv("aes-256-gcm", backupKey(), buf.subarray(at, at + 12));
    d.setAuthTag(buf.subarray(at + 12, at + 28));
    return new Uint8Array(Buffer.concat([d.update(buf.subarray(at + 28)), d.final()]));
  } catch {
    return null;
  }
}
