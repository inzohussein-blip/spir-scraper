import { storeTool } from "@scrapers/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteToolRun } from "@/app/actions";
import {
  Badge,
  Button,
  Card,
  cx,
  fmtDate,
  Notice,
  Stat,
  StatusBadge,
  Table,
} from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** A store tool run: its input, state and dataset (flagged results first), with CSV download. */
export default async function ToolRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ only?: string }>;
}) {
  const [{ id }, { only }] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const rt = await getRuntime();
  const run = await rt.scrapers.getToolRun(id);
  if (!run) notFound();
  const tool = storeTool(run.tool);
  const flaggedOnly = only === "flagged";
  const items = await rt.scrapers.toolRunItems(run.id, { flaggedOnly, limit: 500 });
  const isAds = run.tool === "fb-ads";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link href="/runs" className="text-muted hover:underline">
          التشغيلات
        </Link>
        <span className="text-muted">/</span>
        <Link href={`/store/${run.tool}`} className="hover:underline">
          {tool?.name ?? run.tool}
        </Link>
      </div>
      <Card
        title={tool?.name ?? run.tool}
        icon="database"
        description={<span className="ltr">{s(run.input.query)}</span>}
        actions={
          <div className="flex flex-wrap gap-2">
            <a
              href={`/api/runs/${run.id}/csv`}
              className="rounded-[10px] border border-line px-3 py-1.5 text-sm hover:bg-surface-2"
              download
            >
              تنزيل CSV
            </a>
            <Link
              href={`/store/${run.tool}`}
              className="rounded-[10px] border border-line px-3 py-1.5 text-sm hover:bg-surface-2"
            >
              تشغيل مرة أخرى
            </Link>
            <form action={deleteToolRun.bind(null, run.id)}>
              <Button variant="danger" type="submit" className="px-3 py-1.5">
                حذف
              </Button>
            </form>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="الحالة" value={<StatusBadge status={run.status} />} />
          <Stat label="النتائج" value={run.items} />
          <Stat label={isAds ? "تعمل الآن" : "مهتمون"} value={run.flagged} />
          <Stat
            label="التكلفة التقديرية"
            value={Number(run.costUsd) > 0 ? `$${Number(run.costUsd).toFixed(3)}` : "مجاني"}
          />
        </div>
        <p className="mt-3 text-xs text-muted">
          بدأ {fmtDate(run.startedAt)}
          {run.finishedAt ? ` · انتهى ${fmtDate(run.finishedAt)}` : ""}. تُحذف التشغيلات بعد 90 يوماً.
        </p>
        {run.error && (
          <div className="mt-3">
            <Notice tone="error">{run.error}</Notice>
          </div>
        )}
      </Card>

      <Card
        title="مجموعة النتائج"
        icon="sheet"
        flush
        description={
          isAds
            ? "الإعلانات التي ما زالت تعمل أولاً."
            : "التعليقات التي تسأل عن السعر أو التسجيل أولاً. لا يُرسل لأحد شيء: الرد قرارك."
        }
      >
        <div className="flex gap-2 border-b border-line px-[18px] py-3">
          {[
            ["", "الكل"],
            ["flagged", isAds ? "التي تعمل فقط" : "المهتمون فقط"],
          ].map(([k, label]) => (
            <Link
              key={k || "all"}
              href={k ? `/runs/${run.id}?only=${k}` : `/runs/${run.id}`}
              className={cx(
                "rounded-full border px-3 py-1 text-sm",
                (only ?? "") === k
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line hover:bg-surface-2",
              )}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="px-[18px] py-2">
          {items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">لا نتائج.</p>
          ) : isAds ? (
            <Table head={["المعلن", "نص الإعلان", "الرابط", "بدأ", ""]}>
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="min-w-32">
                    {s(i.data.pageUrl) ? (
                      <a
                        href={s(i.data.pageUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium hover:underline"
                      >
                        {s(i.data.page) || "صفحة"}
                      </a>
                    ) : (
                      s(i.data.page)
                    )}
                    {i.flagged && (
                      <div>
                        <Badge tone="ok">يعمل</Badge>
                      </div>
                    )}
                  </td>
                  <td className="max-w-md text-fg-2">
                    <p className="line-clamp-3">{s(i.data.text) || s(i.data.title)}</p>
                  </td>
                  <td className="ltr max-w-48 truncate">
                    {s(i.data.link) && (
                      <a
                        href={s(i.data.link)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent hover:underline"
                      >
                        {s(i.data.link).replace(/^https?:\/\//, "")}
                      </a>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{s(i.data.startedAt).slice(0, 10)}</td>
                  <td>
                    <a
                      href={s(i.data.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-accent hover:underline"
                    >
                      في المكتبة
                    </a>
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Table head={["الشخص", "التعليق", "إعجابات", "التاريخ"]}>
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="min-w-32">
                    {s(i.data.authorUrl) ? (
                      <a
                        href={s(i.data.authorUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium hover:underline"
                      >
                        {s(i.data.author) || "حساب"}
                      </a>
                    ) : (
                      s(i.data.author)
                    )}
                  </td>
                  <td className="max-w-lg">
                    <p className="line-clamp-3">{s(i.data.text)}</p>
                    {i.flagged && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(Array.isArray(i.data.intent) ? i.data.intent : []).map((w) => (
                          <Badge key={String(w)} tone="ok" dot={false}>
                            {String(w)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="tabular-nums">{s(i.data.likes)}</td>
                  <td className="whitespace-nowrap">{s(i.data.at).slice(0, 10)}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </Card>
    </>
  );
}
