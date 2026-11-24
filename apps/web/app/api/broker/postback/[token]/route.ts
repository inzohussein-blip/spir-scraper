import { parseBrokerEvent } from "@scrapers/core";
import { brokerToken } from "@/lib/backup";
import { meter } from "@/lib/meter";
import { getRuntime } from "@/lib/runtime";
import { safeEqual } from "@/lib/tokens";

export const runtime = "nodejs";

/**
 * The broker's affiliate system calls this on each registration, deposit or
 * commission (a "postback" / "S2S" URL with macros such as {email}, {amount},
 * {subid}). The address itself is the secret.
 */
async function handle(req: Request, token: string) {
  if (!process.env.AUTH_SECRET || !safeEqual(token, brokerToken()))
    return new Response("not found", { status: 404 });
  const params: Record<string, string> = Object.fromEntries(new URL(req.url).searchParams);
  if (req.method === "POST") {
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body))
        if (v !== null && typeof v !== "object") params[k] = String(v);
    } else if (type.includes("form")) {
      for (const [k, v] of (await req.formData()).entries())
        if (typeof v === "string") params[k] = v;
    }
  }
  const event = parseBrokerEvent(params);
  if (!event) return Response.json({ ok: false, error: "unknown event" }, { status: 400 });
  meter("webhooks");
  const r = await (await getRuntime()).scrapers.ingestBrokerEvents([event], "postback");
  return Response.json({ ok: true, ...r });
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(req, (await ctx.params).token);
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(req, (await ctx.params).token);
}
