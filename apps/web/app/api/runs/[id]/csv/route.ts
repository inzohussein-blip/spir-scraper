import { hasSession } from "@/lib/auth";
import { meter } from "@/lib/meter";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 60;

/** A cell safe for spreadsheets: quoted, and formulas neutralised (=, +, -, @). */
function cell(v: unknown): string {
  let s = v == null ? "" : Array.isArray(v) ? v.join(" | ") : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** A store tool run's dataset as CSV (UTF-8 with BOM so Excel shows Arabic). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await hasSession())) return new Response("unauthorized", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("not found", { status: 404 });
  meter("dashboard");
  const rt = await getRuntime();
  const run = await rt.scrapers.getToolRun(id);
  if (!run) return new Response("not found", { status: 404 });
  const items = await rt.scrapers.toolRunItems(id, { limit: 5000 });
  const keys = [...new Set(items.flatMap((i) => Object.keys(i.data)))];
  const lines = [
    ["id", "flagged", ...keys].map(cell).join(","),
    ...items.map((i) =>
      [i.key, i.flagged ? "yes" : "", ...keys.map((k) => i.data[k])].map(cell).join(","),
    ),
  ];
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${run.tool}-${run.startedAt.toISOString().slice(0, 10)}.csv"`,
    },
  });
}
