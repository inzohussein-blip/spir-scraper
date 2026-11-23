import Link from "next/link";
import { buildPersonas } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, cx, fmtNum, Notice } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "العائد" };

const PERIODS: Record<string, { label: string; days: number | null }> = {
  all: { label: "كل الوقت", days: null },
  "90": { label: "آخر 90 يوماً", days: 90 },
  "30": { label: "آخر 30 يوماً", days: 30 },
};

/** "https://www.instagram.com/rival/followers/" → "متابعو @rival". */
function sourceLabel(url: string): string {
  const m =
    /instagram\.com\/(?:explore\/tags\/([^/?#]+)|p\/([^/?#]+)|reel\/([^/?#]+)|([^/?#]+))(\/followers)?/.exec(
      url,
    );
  if (m?.[1]) return `#${m[1]}`;
  if (m?.[2] || m?.[3]) return `منشور ${m[2] ?? m[3]}`;
  if (m?.[4]) return m[5] ? `متابعو @${m[4]}` : `المتفاعلون مع @${m[4]}`;
  if (url.startsWith("mcp:")) return "قائمة من Claude";
  if (url.startsWith("api:")) return "قائمة من الإضافة أو الـ API";
  return url;
}

/** What to do with a source, from its numbers so far. */
function advice(s: {
  leads: number;
  reached: number;
  customers: number;
  roi: number | null;
  costUsd: number;
}): { text: string; tone: "ok" | "warn" | "bad" | "plain" } {
  if (s.customers > 0 && (s.roi === null || s.roi >= 20)) return { text: "ضاعِف", tone: "ok" };
  if (s.customers > 0) return { text: "استمر", tone: "ok" };
  if (s.reached >= 20) return { text: "أوقف أو غيّر الرسالة", tone: "bad" };
  if (s.leads >= 50 && s.reached < 10) return { text: "تواصل مع المزيد أولاً", tone: "warn" };
  return { text: "بيانات قليلة", tone: "plain" };
}

const money = (n: number) => `$${n.toLocaleString("en", { maximumFractionDigits: 2 })}`;

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; period?: string }>;
}) {
  const q = await searchParams;
  const rt = await getRuntime();
  const projects = await rt.scrapers.listProjects();
  const projectId = q.project ?? projects[0]?.id;
  const project = projects.find((p) => p.id === projectId);
  if (!projectId || !project) return <Notice tone="info">لا توجد مشاريع بعد.</Notice>;
  const period = PERIODS[q.period ?? "all"] ?? PERIODS.all;
  const perf = await rt.scrapers.sourcePerformance(projectId, {
    ...(period?.days ? { since: new Date(Date.now() - period.days * 86_400_000) } : {}),
  });
  const { totals } = perf;
  const personas = await rt.scrapers.personaPerformance(projectId);
  const missing = totals.customers - totals.customersWithValue;
  const link = (patch: Record<string, string>) =>
    `/insights?${new URLSearchParams({ project: projectId, period: q.period ?? "all", ...patch })}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {projects.map((p) => (
          <Link
            key={p.id}
            href={link({ project: p.id })}
            className={cx(
              "rounded-full px-3 py-1",
              p.id === projectId ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2",
            )}
          >
            {p.name}
          </Link>
        ))}
        <span className="ms-auto flex gap-2">
          {Object.entries(PERIODS).map(([k, v]) => (
            <Link
              key={k}
              href={link({ period: k })}
              className={cx(
                "rounded-full px-3 py-1",
                (q.period ?? "all") === k ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2",
              )}
            >
              {v.label}
            </Link>
          ))}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: "الإيراد من الصفقات", value: money(totals.revenue) },
          { label: "تكلفة الجمع", value: money(totals.costUsd) },
          {
            label: "العائد لكل دولار",
            value:
              totals.costUsd > 0 ? `${fmtNum(Math.round(totals.revenue / totals.costUsd))}×` : "—",
          },
          { label: "العملاء", value: fmtNum(totals.customers) },
        ].map((k) => (
          <div key={k.label} className="rounded-xl border border-line bg-bg p-4">
            <div className="text-xs text-muted">{k.label}</div>
            <div className="mt-1 text-xl font-bold tabular-nums">{k.value}</div>
          </div>
        ))}
      </div>

      {missing > 0 && (
        <Notice tone="warn">
          {missing} من عملائك بلا قيمة صفقة. سجّلها من صفحة العميل («قيمة الصفقة») حتى يكون العائد
          دقيقاً.
        </Notice>
      )}
      {totals.customers === 0 && (
        <Notice tone="info">
          حين تنقل عميلاً إلى «عميل» وتسجّل قيمة صفقته، يظهر هنا أي منافس أو منشور جاءك منه المال. حتى
          ذلك الحين ترى الأعداد والتكلفة فقط.
        </Notice>
      )}

      <Card
        title={`المصادر · ${project.name}`}
        icon="chart"
        description="الحساب الموجود عند أكثر من منافس يُحسب في كل واحد منهم، وقيمة صفقته تُقسم بينهم بالتساوي. التكلفة تقديرية من سعر المزوّد."
      >
        {perf.sources.length === 0 ? (
          <p className="text-sm text-muted">لا توجد بيانات بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[12.5px] text-muted">
                  {[
                    "المصدر",
                    "الحسابات",
                    "بوسيلة تواصل",
                    "تواصلت",
                    "مهتمون",
                    "عملاء",
                    "الإيراد",
                    "التكلفة",
                    "العائد",
                    "الإغلاق",
                    "التوصية",
                  ].map((h) => (
                    <th key={h} className="px-2 py-2 text-start font-medium first:ps-0">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {perf.sources.map((s) => {
                  const a = advice(s);
                  return (
                    <tr key={s.source} className="border-b border-line last:border-0">
                      <td className="py-2.5 pe-2">
                        <a
                          href={s.source.startsWith("http") ? s.source : undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium hover:text-accent"
                        >
                          {sourceLabel(s.source)}
                        </a>
                        <div className="text-xs text-muted">{s.runs} مهمة</div>
                      </td>
                      <td className="px-2 tabular-nums">{fmtNum(s.leads)}</td>
                      <td className="px-2 tabular-nums">{fmtNum(s.contact)}</td>
                      <td className="px-2 tabular-nums">{fmtNum(s.reached)}</td>
                      <td className="px-2 tabular-nums">{fmtNum(s.interested)}</td>
                      <td className="px-2 tabular-nums">{fmtNum(s.customers)}</td>
                      <td className="px-2 tabular-nums">{s.revenue ? money(s.revenue) : "—"}</td>
                      <td className="px-2 tabular-nums">{s.costUsd ? money(s.costUsd) : "—"}</td>
                      <td className="px-2 tabular-nums">
                        {s.roi !== null ? `${fmtNum(s.roi)}×` : "—"}
                      </td>
                      <td className="px-2 text-xs">
                        {s.closeRate !== null ? `${s.closeRate}%` : "—"}
                        {s.daysToClose !== null && (
                          <div className="text-muted">خلال {s.daysToClose} يوم</div>
                        )}
                      </td>
                      <td className="px-2">
                        <Badge tone={a.tone} dot={false}>
                          {a.text}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card
        title="الشرائح"
        icon="sparkles"
        description="يقرأ الذكاء الاصطناعي عيّنة من البايوهات ويقسم جمهورك إلى شرائح، ثم يوزّع كل العملاء عليها. هنا ترى أي شريحة تجلب المال."
      >
        {personas.length > 0 && (
          <div className="mb-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[12.5px] text-muted">
                  {["الشريحة", "الحسابات", "تواصلت", "عملاء", "الإغلاق", "الإيراد"].map((h) => (
                    <th key={h} className="px-2 py-2 text-start font-medium first:ps-0">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {personas.map((s) => (
                  <tr key={s.persona} className="border-b border-line last:border-0">
                    <td className="py-2.5 pe-2">
                      <Link
                        href={`/leads?project=${projectId}&persona=${encodeURIComponent(s.persona)}`}
                        className="font-medium hover:text-accent"
                      >
                        {s.persona}
                      </Link>
                      <div className="text-xs text-muted">
                        {project.personas?.find((p) => p.name === s.persona)?.description}
                      </div>
                    </td>
                    <td className="px-2 tabular-nums">{fmtNum(s.leads)}</td>
                    <td className="px-2 tabular-nums">{fmtNum(s.reached)}</td>
                    <td className="px-2 tabular-nums">{fmtNum(s.customers)}</td>
                    <td className="px-2">{s.closeRate !== null ? `${s.closeRate}%` : "—"}</td>
                    <td className="px-2 tabular-nums">{s.revenue ? money(s.revenue) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ActionForm
          action={buildPersonas}
          submit={personas.length ? "أعد اكتشاف الشرائح" : "اكتشف الشرائح"}
        >
          <input type="hidden" name="project" value={projectId} />
        </ActionForm>
      </Card>
    </div>
  );
}
