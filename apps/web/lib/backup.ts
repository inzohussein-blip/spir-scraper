import "server-only";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Runtime } from "@scrapers/runtime";

/** A gzipped JSON copy of projects, leads, profiles, notes, monitors and the do-not-contact list. */
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

/** Private calendar address, derived from AUTH_SECRET (rotating it changes the address). */
export function calendarToken(): string {
  return createHash("sha256")
    .update(`calendar:${process.env.AUTH_SECRET ?? ""}`)
    .digest("hex")
    .slice(0, 40);
}
