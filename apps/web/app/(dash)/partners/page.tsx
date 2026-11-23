import {
  createPartner,
  importBrokerCsv,
  recruitPartner,
  saveBrokerSettings,
  togglePartner,
} from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, fmtDate, fmtNum, Input, Notice } from "@/components/ui";
import { brokerToken } from "@/lib/backup";
import { appOrigin } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "الوكلاء" };

const EVENT_LABELS: Record<string, string> = {
  registration: "تسجيل",
  ftd: "أول إيداع",
  deposit: "إيداع",
  trade: "تداول",
  commission: "عمولة",
};
const money = (n: number) => `$${n.toLocaleString("en", { maximumFractionDigits: 2 })}`;

export default async function PartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const q = await searchParams;
  const rt = await getRuntime();
  const origin = appOrigin();
  const projects = await rt.scrapers.listProjects();
  const projectId = q.project ?? projects[0]?.id;
  const [settings, summary, stats, recruits] = await Promise.all([
    rt.scrapers.getValue<{ signupUrl?: string | null; subParam?: string }>("broker:settings"),
    rt.scrapers.brokerSummary(),
    rt.scrapers.partnerStats(),
    projectId ? rt.scrapers.recruitCandidates(projectId, 10) : Promise.resolve([]),
  ]);
  const postback = `${origin}/api/broker/postback/${brokerToken()}`;
  const events = Object.entries(summary.byEvent);

  return (
    <div className="space-y-4">
      <Card
        title="تقارير الوسيط"
        icon="plug"
        description="ما يرسله الوسيط (تسجيل، أول إيداع، عمولة) يُطابَق مع عملائك بالإيميل أو الهاتف، فتُسجَّل الصفقة وقيمتها وحدها، ويُنسب لوكيلها."
      >
        <div className="space-y-4 text-sm">
          <Field
            label="رابط الإشعارات (Postback) — ضعه في لوحة الوسيط"
            hint="الأسماء بين {} أمثلة؛ استبدلها بأسماء نظام الوسيط (CellXpert وMyAffiliates وغيرهما). لا تشارك الرابط: من يملكه يستطيع إرسال أحداث."
          >
            <Input
              readOnly
              className="ltr font-mono text-xs"
              value={`${postback}?event={event}&email={email}&phone={phone}&amount={amount}&currency={currency}&sub={subid}&client_id={player_id}`}
              aria-label="رابط إشعارات الوسيط"
            />
          </Field>
          <ActionForm
            action={importBrokerCsv}
            submit="استورد التقرير"
            className="flex flex-wrap items-end gap-2"
          >
            <Field label="أو ارفع تقريراً (CSV) من لوحة الوسيط">
              <Input type="file" name="file" accept=".csv,text/csv" aria-label="تقرير الوسيط" />
            </Field>
          </ActionForm>
          {events.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {events.map(([e, v]) => (
                <Badge key={e} tone={v.matched ? "ok" : "plain"} dot={false}>
                  {EVENT_LABELS[e] ?? e}: {fmtNum(v.count)} (طوبق {fmtNum(v.matched)})
                  {v.amount ? ` · ${money(v.amount)}` : ""}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-muted">لم يصل شيء من الوسيط بعد.</p>
          )}
        </div>
      </Card>

      <Card
        title="رابط التسجيل للوكلاء"
        icon="settings"
        description="رابط الإحالة عند الوسيط. كل وكيل يحصل على رابط قصير يمرّ عبر المنصة (لعدّ الزيارات) ثم يذهب لهذا الرابط مع كوده."
      >
        <ActionForm
          action={saveBrokerSettings}
          submit="حفظ"
          className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
        >
          <Field label="رابط التسجيل عند الوسيط">
            <Input
              name="signup_url"
              className="ltr"
              defaultValue={settings?.signupUrl ?? ""}
              placeholder="https://broker.com/register?affid=123"
            />
          </Field>
          <Field label="اسم حقل الكود">
            <Input name="sub_param" className="ltr" defaultValue={settings?.subParam ?? "sub"} />
          </Field>
        </ActionForm>
      </Card>

      <Card
        title="الوكلاء"
        icon="users"
        description="من يجلب لك العملاء: رابطه، ونتائجه من تقارير الوسيط، وحصته."
      >
        {stats.length > 0 && (
          <div className="mb-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[12.5px] text-muted">
                  {[
                    "الوكيل",
                    "زيارات",
                    "تسجيلات",
                    "أول إيداع",
                    "الإيداعات",
                    "العمولة",
                    "حصته",
                    "روابط",
                    "",
                  ].map((h) => (
                    <th key={h} className="px-2 py-2 text-start font-medium first:ps-0">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.map((p) => (
                  <tr key={p.id} className="border-b border-line align-top last:border-0">
                    <td className="py-2.5 pe-2">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted">
                        {p.instagram ? `@${p.instagram} · ` : ""}
                        {p.sharePercent}% · منذ {fmtDate(p.createdAt)}
                      </div>
                    </td>
                    <td className="px-2 tabular-nums">{fmtNum(p.clicks)}</td>
                    <td className="px-2 tabular-nums">{fmtNum(p.registrations)}</td>
                    <td className="px-2 tabular-nums">{fmtNum(p.ftds)}</td>
                    <td className="px-2 tabular-nums">{money(p.deposits)}</td>
                    <td className="px-2 tabular-nums">{money(p.commission)}</td>
                    <td className="px-2 tabular-nums">{money(p.partnerShare)}</td>
                    <td className="px-2 text-xs">
                      <div className="ltr select-all">{`${origin}/r/${p.code}`}</div>
                      <a
                        href={`/p/${p.portalToken}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent hover:underline"
                      >
                        لوحته (أرسلها له)
                      </a>
                    </td>
                    <td className="px-2">
                      <form action={togglePartner.bind(null, p.id, !p.active)}>
                        <button
                          type="submit"
                          className="rounded px-2 py-0.5 text-xs text-muted hover:bg-bg-2"
                        >
                          {p.active ? "إيقاف" : "تفعيل"}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ActionForm
          action={createPartner}
          submit="أضف وكيلاً"
          className="grid gap-3 sm:grid-cols-4 sm:items-end"
        >
          <Field label="الاسم">
            <Input name="name" required />
          </Field>
          <Field label="حسابه (اختياري)">
            <Input name="instagram" className="ltr" placeholder="@coach" />
          </Field>
          <Field label="حصته من العمولة %">
            <Input name="share" type="number" min={0} max={100} defaultValue={30} />
          </Field>
          <Field label="كود (اختياري)">
            <Input name="code" className="ltr" placeholder="gold7" />
          </Field>
        </ActionForm>
      </Card>

      <Card
        title="مرشحون للشراكة"
        icon="sparkles"
        description="من عملائك: حسابات لها جمهور (5 آلاف فأكثر) متفاعل، والأعلى نمواً واحتمالاً ودرجة أولاً. تواصل معهم بنفسك."
      >
        {!projectId ? (
          <Notice tone="info">لا توجد مشاريع بعد.</Notice>
        ) : recruits.length === 0 ? (
          <p className="text-sm text-muted">لا يوجد مرشحون بعد في هذا المشروع.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {recruits.map((r) => (
              <li key={r.username} className="flex flex-wrap items-center gap-2 py-2">
                <a
                  href={`/leads/${r.username}?project=${projectId}`}
                  className="ltr font-medium text-accent hover:underline"
                >
                  @{r.username}
                </a>
                <span className="text-xs text-muted">
                  {fmtNum(r.followers)} متابع
                  {r.engagementRate !== null ? ` · تفاعل ${r.engagementRate.toFixed(1)}%` : ""}
                  {r.persona ? ` · ${r.persona}` : ""}
                </span>
                {r.signals?.includes("rising") && (
                  <Badge tone="ok" dot={false}>
                    ينمو بسرعة
                  </Badge>
                )}
                <form
                  action={recruitPartner.bind(null, r.username, r.fullName ?? "")}
                  className="ms-auto"
                >
                  <button
                    type="submit"
                    className="rounded px-2 py-0.5 text-xs text-accent hover:bg-accent-soft"
                  >
                    أضفه كوكيل
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
