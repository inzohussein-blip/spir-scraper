import { parseBackup, type RestoreResult } from "@scrapers/core";
import { audit } from "@/lib/audit";
import { hasSession } from "@/lib/auth";
import { readBackup } from "@/lib/backup";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Vercel accepts request bodies up to about 4.5 MB; larger files go through the CLI. */
const MAX_BYTES = 4_400_000;

const text = (msg: string, status: number) =>
  new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * Restores a backup (.enc from Telegram, .json.gz download or .json) by
 * merging: missing rows are added, existing ones are left as they are,
 * nothing is deleted.
 */
export async function POST(req: Request) {
  if (!(await hasSession())) return text("unauthorized", 401);
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (form?.get("confirm") !== "yes") return text("أكّد الاستعادة بوضع علامة في خانة التأكيد.", 400);
  if (!(file instanceof File) || file.size === 0) return text("اختر ملف النسخة.", 400);
  if (file.size > MAX_BYTES)
    return text(
      "الملف أكبر من حد الرفع على Vercel (4.5 ميغابايت). استعده من جهازك: scrapers backup restore <الملف>",
      413,
    );
  let restored: RestoreResult;
  try {
    const data = parseBackup(readBackup(new Uint8Array(await file.arrayBuffer())));
    restored = await (await getRuntime()).scrapers.importBackup(data);
  } catch (e) {
    return text(e instanceof Error ? e.message : "تعذّرت الاستعادة.", 400);
  }
  const added = Object.fromEntries(Object.entries(restored).map(([k, v]) => [k, v.added]));
  await audit("backup.restore", { bytes: file.size, added });
  const q = new URLSearchParams({
    restored: "1",
    projects: String(restored.projects.added),
    leads: String(restored.leads.added),
    notes: String(restored.leadEvents.added),
  });
  return Response.redirect(new URL(`/settings?${q}`, req.url), 303);
}
