import { hasSession } from "@/lib/auth";
import { buildBackup } from "@/lib/backup";
import { meter } from "@/lib/meter";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Owner download of everything (Settings → النسخ الاحتياطي). */
export async function GET() {
  if (!(await hasSession())) return new Response("unauthorized", { status: 401 });
  meter("dashboard");
  const rt = await getRuntime();
  const b = await buildBackup(rt);
  await rt.scrapers.audit({
    actor: "owner",
    action: "backup.download",
    detail: { bytes: b.bytes.length },
  });
  return new Response(b.bytes, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${b.name}"`,
      "cache-control": "no-store",
    },
  });
}
