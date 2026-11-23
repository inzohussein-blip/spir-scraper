import { createHmac } from "node:crypto";
import { metaVerifyToken } from "@/lib/backup";
import { getRuntime } from "@/lib/runtime";
import { safeEqual } from "@/lib/tokens";

export const runtime = "nodejs";

/** Meta asks once to confirm the subscription with the verify token shown in Settings. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  if (
    q.get("hub.mode") === "subscribe" &&
    process.env.AUTH_SECRET &&
    safeEqual(q.get("hub.verify_token") ?? "", metaVerifyToken())
  )
    return new Response(q.get("hub.challenge") ?? "", { status: 200 });
  return new Response("forbidden", { status: 403 });
}

type Entry = {
  id?: string;
  messaging?: {
    sender?: { id?: string };
    recipient?: { id?: string };
    timestamp?: number;
    message?: { mid?: string; text?: string; is_echo?: boolean };
  }[];
  changes?: {
    field?: string;
    value?: { id?: string; text?: string; from?: { username?: string }; media?: { id?: string } };
  }[];
};

/**
 * Direct messages and comments on the owner's account. Every request must be
 * signed by Meta with the app secret (X-Hub-Signature-256).
 */
export async function POST(req: Request) {
  const secret = process.env.META_APP_SECRET;
  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const expected = secret ? `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` : "";
  if (!secret || !safeEqual(signature, expected))
    return new Response("unauthorized", { status: 401 });
  const body = JSON.parse(raw || "{}") as { entry?: Entry[] };
  const rt = await getRuntime();
  const own = process.env.IG_BUSINESS_ACCOUNT_ID;
  for (const entry of body.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      const from = m.sender?.id;
      const text = m.message?.text;
      if (!from || !text || !m.message?.mid) continue;
      // Echoes are the owner's own messages sent from the Instagram app.
      const outgoing = m.message.is_echo === true || from === own;
      await rt.scrapers.storeMessage({
        id: m.message.mid,
        threadId: outgoing ? (m.recipient?.id ?? from) : from,
        direction: outgoing ? "out" : "in",
        text,
        ...(m.timestamp ? { at: new Date(m.timestamp) } : {}),
      });
    }
    for (const c of entry.changes ?? []) {
      const v = c.value;
      if (c.field !== "comments" || !v?.id || !v.text || !v.media?.id) continue;
      await rt.scrapers.storeComment({
        id: v.id,
        mediaId: v.media.id,
        username: v.from?.username ?? null,
        text: v.text,
      });
    }
  }
  return Response.json({ ok: true });
}
