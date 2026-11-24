import { audit } from "@/lib/audit";
import { hasSession } from "@/lib/auth";
import { openBackup } from "@/lib/backup";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Opens an encrypted backup (the weekly copy sent to Telegram) and returns the .json.gz. */
export async function POST(req: Request) {
  if (!(await hasSession())) return new Response("unauthorized", { status: 401 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > 60_000_000)
    return new Response("اختر ملف النسخة المشفّرة (.enc)", { status: 400 });
  const plain = openBackup(new Uint8Array(await file.arrayBuffer()));
  if (!plain)
    return new Response(
      "تعذّر فك التشفير: الملف ليس نسخة من هذه المنصة، أو تغيّر AUTH_SECRET منذ إنشائها.",
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  await audit("backup.decrypt", { bytes: plain.byteLength });
  const name = file.name.replace(/\.enc$/i, "") || "spir-backup.json.gz";
  return new Response(Buffer.from(plain), {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
    },
  });
}
