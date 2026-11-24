import { STORE_TOOLS, storeTool } from "@scrapers/core";
import Link from "next/link";
import { Badge, Card, cx, fmtDate, StatusBadge, Table } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

type Row = {
  key: string;
  tool: string;
  input: string;
  status: string;
  results: string;
  cost: number;
  at: Date;
  href: string;
  kind: "job" | "tool" | "engine";
};

const KINDS = {
  "": "الكل",
  job: "جمع عملاء",
  tool: "أدوات بيانات",
  engine: "محرك Spir",
} as const;

/**
 * «التشغيلات»: every run in one list, newest first: collection jobs (leads),
 * store tool runs (datasets) and Spir engine runs.
 */
export default async function Runs({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind = "" } = await searchParams;
  const rt = await getRuntime();
  const [jobs, toolRuns, engineRuns] = await Promise.all([
    rt.scrapers.listJobs({ limit: 100 }),
    rt.scrapers.listToolRuns({ limit: 100 }),
    rt.scrapers.listEngineRuns(50),
  ]);
  const jobTool = (type: string) =>
    STORE_TOOLS.find((t) => t.run.kind === "job" && t.run.sourceType === type)?.name ?? type;

  const rows: Row[] = [
    ...jobs.map(
      (j): Row => ({
        key: `j${j.id}`,
        tool: jobTool(j.sourceType),
        input: j.sourceUrl,
        status: j.status,
        results: `${j.counts.enriched ?? 0} عميل`,
        cost: Number(j.costUsd),
        at: j.createdAt,
        href: `/jobs/${j.id}`,
        kind: "job",
      }),
    ),
    ...toolRuns.map(
      (r): Row => ({
        key: `t${r.id}`,
        tool: storeTool(r.tool)?.name ?? r.tool,
        input: String(r.input.query ?? ""),
        status: r.status,
        results: `${r.items} نتيجة${r.flagged ? ` · ${r.flagged} مهم` : ""}`,
        cost: Number(r.costUsd),
        at: r.startedAt,
        href: `/runs/${r.id}`,
        kind: "tool",
      }),
    ),
    ...engineRuns.map(
      (e): Row => ({
        key: `e${e.id}`,
        tool: "محرك Spir",
        input: e.name,
        status: e.status === "active" ? "running" : e.status,
        results: `${e.counts.accepted ?? 0} مقبول من ${e.counts.read ?? 0}`,
        cost: 0,
        at: e.createdAt,
        href: `/engine/${e.id}`,
        kind: "engine",
      }),
    ),
  ]
    .filter((r) => !kind || r.kind === kind)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const total = rows.reduce((s, r) => s + r.cost, 0);

  return (
    <Card
      title="التشغيلات"
      icon="clock"
      description="كل تشغيل لأي أداة، الأحدث أولاً. افتح التشغيل لترى نتائجه أو تنزّلها."
      actions={
        <Link
          href="/store"
          className="rounded-[10px] border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-accent-text"
        >
          تشغيل أداة
        </Link>
      }
      flush
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-[18px] py-3">
        {(Object.keys(KINDS) as (keyof typeof KINDS)[]).map((k) => (
          <Link
            key={k || "all"}
            href={k ? `/runs?kind=${k}` : "/runs"}
            className={cx(
              "rounded-full border px-3 py-1 text-sm",
              kind === k
                ? "border-accent bg-accent-soft text-accent"
                : "border-line hover:bg-surface-2",
            )}
          >
            {KINDS[k]}
          </Link>
        ))}
        <span className="ms-auto text-xs text-muted">تكلفة المعروض: ${total.toFixed(2)}</span>
      </div>
      <div className="px-[18px] py-2">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            لا تشغيلات بعد.{" "}
            <Link href="/store" className="text-accent underline">
              اختر أداة من المتجر
            </Link>
            .
          </p>
        ) : (
          <Table head={["الأداة", "الإدخال", "الحالة", "النتائج", "التكلفة", "البداية"]}>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <Link href={r.href} className="font-medium text-accent hover:underline">
                    {r.tool}
                  </Link>
                </td>
                <td className="ltr max-w-72 truncate text-fg-2">{r.input}</td>
                <td>
                  {r.status === "paused" ? (
                    <Badge tone="plain">متوقف</Badge>
                  ) : (
                    <StatusBadge status={r.status} />
                  )}
                </td>
                <td className="whitespace-nowrap tabular-nums">{r.results}</td>
                <td className="tabular-nums">{r.cost > 0 ? `$${r.cost.toFixed(3)}` : "مجاني"}</td>
                <td className="whitespace-nowrap text-fg-2">{fmtDate(r.at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </Card>
  );
}
