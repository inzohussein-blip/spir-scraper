import { hasSession } from "@/lib/auth";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 60;

/** One CSV cell; a leading = + - @ is neutralised so spreadsheets do not run it as a formula. */
function cell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A run's dataset as CSV (every account read, accepted or not). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await hasSession())) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const rt = await getRuntime();
  const rows = await rt.scrapers.engineDataset(id, { limit: 50_000 });
  const header = [
    "username",
    "accepted",
    "note",
    "followers",
    "full_name",
    "category",
    "business",
    "email",
    "website",
    "depth",
    "found_via",
    "read_at",
    "bio",
  ];
  const lines = rows.map((r) =>
    [
      r.username,
      r.accepted ? "yes" : "no",
      r.note,
      r.followers,
      r.fullName,
      r.category,
      r.isBusiness ? "yes" : "",
      r.businessEmail,
      r.externalUrl,
      r.depth,
      r.referrer,
      r.readAt?.toISOString(),
      r.bio,
    ]
      .map(cell)
      .join(","),
  );
  return new Response(`﻿${[header.join(","), ...lines].join("\r\n")}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="spir-engine-${id.slice(0, 8)}.csv"`,
    },
  });
}
