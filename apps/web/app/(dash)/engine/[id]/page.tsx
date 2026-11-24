import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, fmtAgo, fmtNum, Kpi, LinkButton } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "تشغيل محرك Spir" };

export default async function EngineRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ only?: string }>;
}) {
  const { id } = await params;
  const { only } = await searchParams;
  const rt = await getRuntime();
  const detail = await rt.scrapers.engineRun(id);
  if (!detail) notFound();
  const { run, queue, next } = detail;
  const acceptedOnly = only === "accepted";
  const [rows, events] = await Promise.all([
    rt.scrapers.engineDataset(id, { acceptedOnly, limit: 300 }),
    rt.scrapers.engineEvents(20, id),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/engine" className="text-sm text-accent hover:underline">
          ← محرك Spir
        </Link>
        <h1 className="text-lg font-bold">{run.name}</h1>
        <span className="text-xs text-muted">
          {run.maxDepth === 0 ? "قراءة قائمة" : `زحف بعمق ${run.maxDepth}`}
          {run.keywords?.length ? ` · ${run.keywords.join("، ")}` : ""}
          {run.minFollowers ? ` · ${fmtNum(run.minFollowers)}+ متابع` : ""}
        </span>
        <LinkButton href={`/api/engine/runs/${id}/csv`} className="ms-auto">
          تنزيل CSV
        </LinkButton>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="قُرئ"
          value={`${fmtNum(run.counts.read ?? 0)} / ${fmtNum(run.maxAccounts)}`}
          icon="activity"
        />
        <Kpi label="قُبل وأُرسل للمشروع" value={fmtNum(run.counts.accepted ?? 0)} icon="check" />
        <Kpi label="تُخطي" value={fmtNum(run.counts.skipped ?? 0)} icon="users" />
        <Kpi
          label="في الطابور"
          value={fmtNum(queue.queued ?? 0)}
          hint={queue.failed ? `فشل ${queue.failed}` : undefined}
          icon="folder"
        />
      </div>

      <Card
        title="النتائج"
        icon="sheet"
        description="كل حساب قرأه المحرك (مثل dataset في Apify). المقبولون يصلون لصفحة العملاء في المشروع خلال دقائق."
      >
        <div className="mb-3 flex gap-2 text-sm">
          <Link
            href={`/engine/${id}`}
            className={acceptedOnly ? "text-muted hover:underline" : "font-medium"}
          >
            الكل
          </Link>
          <Link
            href={`/engine/${id}?only=accepted`}
            className={acceptedOnly ? "font-medium" : "text-muted hover:underline"}
          >
            المقبولون فقط
          </Link>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">لم يُقرأ شيء بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[12.5px] text-muted">
                  {["الحساب", "متابعون", "البايو", "وُجد عبر", "النتيجة", "متى"].map((h) => (
                    <th key={h} className="px-2 py-2 text-start font-medium first:ps-0">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.username} className="border-b border-line align-top last:border-0">
                    <td className="py-2 pe-2">
                      <a
                        href={`https://instagram.com/${r.username}`}
                        target="_blank"
                        rel="noreferrer"
                        className="ltr font-medium text-accent hover:underline"
                      >
                        @{r.username}
                      </a>
                      {r.fullName && <div className="text-xs text-muted">{r.fullName}</div>}
                    </td>
                    <td className="px-2 tabular-nums">{fmtNum(r.followers)}</td>
                    <td className="max-w-xs px-2 text-xs text-fg-2">
                      <span className="line-clamp-2">{r.bio}</span>
                    </td>
                    <td className="px-2 text-xs text-muted">
                      {r.referrer ? <span className="ltr">@{r.referrer}</span> : "بذرة"}
                    </td>
                    <td className="px-2">
                      <Badge tone={r.accepted ? "ok" : "plain"} dot={false}>
                        {r.accepted ? "قُبل" : "تُخطي"}
                      </Badge>
                      {r.note && <div className="mt-0.5 text-xs text-muted">{r.note}</div>}
                    </td>
                    <td className="px-2 text-xs text-muted">{r.readAt ? fmtAgo(r.readAt) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="التالي في الطابور"
          icon="users"
          description="الأعلى أولوية أولاً: من ذكرهم حساب في مجالك، أو أكثر من حساب، أو في البايو."
        >
          {next.length === 0 ? (
            <p className="text-sm text-muted">الطابور فارغ.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {next.map((n) => (
                <li key={n.username} className="flex items-center gap-2 py-1.5">
                  <span className="ltr font-medium">@{n.username}</span>
                  <span className="text-xs text-muted">
                    عمق {n.depth}
                    {n.referrer ? ` · عبر @${n.referrer}` : ""}
                  </span>
                  <span className="ms-auto text-xs tabular-nums text-muted">
                    أولوية {n.priority}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="السجل" icon="bell">
          {events.length === 0 ? (
            <p className="text-sm text-muted">لا شيء بعد.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <span className="w-24 shrink-0 text-xs text-muted">{fmtAgo(e.at)}</span>
                  <span>{e.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
