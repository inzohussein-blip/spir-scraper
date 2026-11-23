import { calendarToken } from "@/lib/backup";
import { appOrigin } from "@/lib/env";
import { followUpCalendar } from "@/lib/ics";
import { getRuntime } from "@/lib/runtime";
import { STATUS_LABELS } from "@/lib/status";
import { safeEqual } from "@/lib/tokens";

export const runtime = "nodejs";

/**
 * Follow-up reminders as a calendar feed (Google Calendar → Add calendar → From URL).
 * The address itself is the secret, as calendar apps cannot log in.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!process.env.AUTH_SECRET || !safeEqual(token.replace(/\.ics$/, ""), calendarToken()))
    return new Response("not found", { status: 404 });
  const rt = await getRuntime();
  const rows = await rt.scrapers.upcomingFollowUps();
  const body = followUpCalendar(
    rows.map((r) => ({ ...r, status: STATUS_LABELS[r.status] ?? r.status })),
    appOrigin(req),
  );
  return new Response(body, {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" },
  });
}
