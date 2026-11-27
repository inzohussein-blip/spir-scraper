import { meter } from "@/lib/meter";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Reports from the owner's reverse-api-engineer bridge (twice per run: when
 * it accepts and when it ends). Authenticated by a token derived from
 * RAE_RELAY_SECRET, and the body is sealed with keys from the same secret.
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return new Response("unauthorized", { status: 401 });
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > 4_000_000) return new Response("too large", { status: 413 });
  const body = (await req.json().catch(() => null)) as { sealed?: unknown } | null;
  if (typeof body?.sealed !== "string") return new Response("bad request", { status: 400 });
  meter("mcp");
  const ok = await (await getRuntime()).scrapers.raeRelayReport(token, body.sealed);
  return ok ? Response.json({ ok: true }) : new Response("unauthorized", { status: 401 });
}
