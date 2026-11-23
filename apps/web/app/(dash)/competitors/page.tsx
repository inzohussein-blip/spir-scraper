import { analyzeCompetitor } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, cx, fmtDate, fmtNum, Input, Notice, Select } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "المنافسون" };

type Analysis = Awaited<
  ReturnType<Awaited<ReturnType<typeof getRuntime>>["scrapers"]["analyzeCompetitor"]>
>;

const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const TYPES: Record<string, string> = { video: "فيديو/ريلز", image: "صورة", carousel: "ألبوم" };
const hour = (h: number) => `${h % 12 || 12}${h < 12 ? " ص" : " م"}`;

/** A small follower line from the daily snapshots (no chart library). */
function Sparkline({ points }: { points: { at: Date; followers: number | null }[] }) {
  const values = points.map((p) => p.followers).filter((v): v is number => v !== null);
  if (values.length < 2)
    return <p className="text-xs text-muted">يظهر الخط بعد يومين من المراقبة.</p>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const path = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / span) * 28 - 1}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" className="h-10 w-full" preserveAspectRatio="none" aria-hidden>
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-accent"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default async function CompetitorsPage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string }>;
}) {
  const { u } = await searchParams;
  const rt = await getRuntime();
  const [projects, monitors, list] = await Promise.all([
    rt.scrapers.listProjects(),
    rt.scrapers.listMonitors(),
    rt.scrapers.getValue<string[]>("competitor:list"),
  ]);
  const watched = [
    ...new Set([
      ...(list ?? []),
      ...monitors
        .map((m) => /instagram\.com\/([A-Za-z0-9._]{1,30})/.exec(m.sourceUrl)?.[1]?.toLowerCase())
        .filter((x): x is string => !!x),
    ]),
  ];
  const selected = u?.toLowerCase() ?? watched[0];
  const [analysis, history] = selected
    ? await Promise.all([
        rt.scrapers.getValue<Analysis>(`competitor:${selected}`),
        rt.scrapers.competitorHistory(selected),
      ])
    : [null, []];

  return (
    <div className="space-y-4">
      <Card
        title="حلّل منافساً"
        icon="radar"
        description="يقرأ الحساب وآخر منشوراته: ماذا ينجح عنده، ومتى ينشر، وكم نما. كل تحليل يكلّف قراءة حساب واحد من Apify (أقل من سنت)."
      >
        <ActionForm
          action={analyzeCompetitor}
          submit="حلّل"
          className="grid gap-3 sm:grid-cols-[1fr_14rem_auto] sm:items-start"
        >
          <Input
            name="username"
            required
            className="ltr"
            placeholder="@competitor"
            defaultValue={u ?? ""}
            aria-label="حساب المنافس"
          />
          <Select
            name="project"
            defaultValue={projects[0]?.id ?? ""}
            aria-label="المشروع (لهدف التحليل)"
          >
            <option value="">بدون مشروع</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                هدف: {p.name}
              </option>
            ))}
          </Select>
        </ActionForm>
        {watched.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2 text-sm">
            {watched.map((w) => (
              <a
                key={w}
                href={`/competitors?u=${w}`}
                className={cx(
                  "ltr rounded-full px-3 py-1",
                  w === selected ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2",
                )}
              >
                @{w}
              </a>
            ))}
          </div>
        )}
      </Card>

      {selected && !analysis && (
        <Notice tone="info">
          @{selected} مراقَب لكن لم يُحلَّل بعد. اكتب معرّفه في الأعلى واضغط «حلّل».
        </Notice>
      )}

      {analysis && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card
            title={`@${analysis.username}`}
            icon="chart"
            description={
              [analysis.fullName, analysis.category].filter(Boolean).join(" · ") || undefined
            }
          >
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted">المتابعون</dt>
                <dd className="tabular-nums">{fmtNum(analysis.followers)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">التفاعل</dt>
                <dd>
                  {analysis.analysis.engagementRate !== null
                    ? `${analysis.analysis.engagementRate}%`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">ينشر كل</dt>
                <dd>
                  {analysis.analysis.postEveryDays !== null
                    ? `${analysis.analysis.postEveryDays} يوم`
                    : "—"}
                </dd>
              </div>
            </dl>
            {analysis.growth && (
              <p className="mt-3 text-sm">
                منذ {fmtDate(analysis.growth.since)}:{" "}
                <Badge tone={analysis.growth.followers >= 0 ? "ok" : "bad"} dot={false}>
                  {analysis.growth.followers >= 0 ? "+" : ""}
                  {fmtNum(analysis.growth.followers)}
                  {analysis.growth.percent !== null ? ` (${analysis.growth.percent}%)` : ""}
                </Badge>
              </p>
            )}
            <div className="mt-3">
              <Sparkline points={history} />
            </div>
            <ul className="mt-3 space-y-1.5 text-sm">
              {analysis.analysis.byType.length > 0 && (
                <li>
                  الأنجح:{" "}
                  {analysis.analysis.byType
                    .map((t) => `${TYPES[t.type] ?? t.type} (${fmtNum(t.avg)} تفاعل)`)
                    .join("، ")}
                </li>
              )}
              {analysis.analysis.bestDays.length > 0 && (
                <li>أفضل الأيام: {analysis.analysis.bestDays.map((d) => DAYS[d]).join("، ")}</li>
              )}
              {analysis.analysis.bestHours.length > 0 && (
                <li>
                  أفضل الساعات:{" "}
                  <span className="ltr">{analysis.analysis.bestHours.map(hour).join("، ")}</span>
                </li>
              )}
              {analysis.analysis.topHashtags.length > 0 && (
                <li className="ltr text-start">
                  {analysis.analysis.topHashtags.map((h) => `#${h.tag}`).join(" ")}
                </li>
              )}
            </ul>
            {analysis.analysis.topPosts.length > 0 && (
              <div className="mt-3">
                <h3 className="mb-1 text-xs text-muted">أقوى المنشورات</h3>
                <ul className="space-y-1.5 text-sm">
                  {analysis.analysis.topPosts.map((p) => (
                    <li key={p.url ?? p.interactions}>
                      {p.url ? (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline"
                        >
                          {fmtNum(p.interactions)} تفاعل
                        </a>
                      ) : (
                        `${fmtNum(p.interactions)} تفاعل`
                      )}
                      {p.caption && <span className="text-muted"> · {p.caption.slice(0, 90)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          <Card title="قراءة الذكاء الاصطناعي وأفكار محتوى" icon="sparkles">
            {analysis.brief ? (
              <div className="whitespace-pre-line text-sm leading-7">{analysis.brief}</div>
            ) : (
              <p className="text-sm text-muted">
                الأفكار المكتوبة تحتاج ANTHROPIC_API_KEY. الأرقام في البطاقة الأخرى تعمل بدونه.
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
