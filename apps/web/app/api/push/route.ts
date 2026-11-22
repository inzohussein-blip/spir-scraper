import { hasSession } from "@/lib/auth";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";

type Body = { endpoint?: string; keys?: { p256dh?: string; auth?: string } };

/** Saves (POST) or removes (DELETE) this browser's push subscription. */
export async function POST(req: Request) {
  if (!(await hasSession())) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Body;
  if (!b.endpoint?.startsWith("https://") || !b.keys?.p256dh || !b.keys.auth) {
    return Response.json({ error: "invalid subscription" }, { status: 400 });
  }
  await (await getRuntime()).scrapers.savePushSubscription({
    endpoint: b.endpoint,
    p256dh: b.keys.p256dh,
    auth: b.keys.auth,
  });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  if (!(await hasSession())) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Body;
  if (b.endpoint) await (await getRuntime()).scrapers.deletePushSubscription(b.endpoint);
  return Response.json({ ok: true });
}
