import "server-only";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { openBackup as openWith, readBackupFile, sealBackup as sealWith } from "@scrapers/core";
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

const secret = () => process.env.AUTH_SECRET ?? "";

/**
 * Encrypts a backup (AES-256-GCM, key from AUTH_SECRET) before it leaves the
 * platform, e.g. to Telegram. Open it in Settings → «فك تشفير نسخة».
 */
export function sealBackup(bytes: Uint8Array): Uint8Array {
  return sealWith(bytes, secret());
}

/** The gzipped backup back, or null when the file is not one of ours or AUTH_SECRET changed. */
export function openBackup(sealed: Uint8Array): Uint8Array | null {
  return openWith(sealed, secret());
}

/** The backup's JSON text from an .enc, .json.gz or .json file (throws a message for the owner). */
export function readBackup(bytes: Uint8Array): string {
  return readBackupFile(bytes, secret());
}
