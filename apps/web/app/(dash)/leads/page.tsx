import { LANGUAGE_LABELS, PLATFORM_LABELS, type Platform } from "@scrapers/core";
import Link from "next/link";
import {
  addMonitor,
  bulkLeads,
  linkProjectAccounts,
  removeMonitor,
  suppress,
  toggleMonitor,
  updateProjectSettings,
} from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { FollowUpInput } from "@/components/follow-up";
import { SelectAll } from "@/components/select-all";
import { StatusSelect } from "@/components/status-select";
import {
  Badge,
  Button,
  Card,
  cx,
  Field,
  fmtDate,
  fmtNum,
  Input,
  LinkButton,
  Notice,
  Select,
  Textarea,
} from "@/components/ui";
import { integrationStatus } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";
import { STATUS_LABELS } from "@/lib/status";
import { fillTemplate, waLink } from "@/lib/whatsapp";

type Search = {
  project?: string;
  job?: string;
  business?: string;
  has_email?: string;
  has_phone?: string;
  min_score?: string;
  status?: string;
  q?: string;
  cursor?: string;
  country?: string;
  language?: string;
  min_sources?: string;
  ask?: string;
  persona?: string;
  signal?: string;
  platform?: string;
};

/** Countries offered in the filter; the most common markets first. */
const COUNTRIES: Record<string, string> = {
  SA: "السعودية",
  AE: "الإمارات",
  KW: "الكويت",
  QA: "قطر",
  BH: "البحرين",
  OM: "عُمان",
  IQ: "العراق",
  EG: "مصر",
  JO: "الأردن",
  LB: "لبنان",
  SY: "سوريا",
  PS: "فلسطين",
  YE: "اليمن",
  LY: "ليبيا",
  TN: "تونس",
  DZ: "الجزائر",
  MA: "المغرب",
  SD: "السودان",
  TR: "تركيا",
  IR: "إيران",
  GB: "بريطانيا",
  US: "أمريكا",
};
const QUERY_LABELS: Record<string, string> = {
  status: "الحالة",
  minScore: "أدنى درجة",
  country: "الدولة",
  language: "اللغة",
  business: "تجاري",
  hasEmail: "له إيميل",
  hasPhone: "له رقم",
  minFollowers: "متابعون من",
  maxFollowers: "متابعون إلى",
  minSources: "عدد المصادر",
  q: "كلمات",
  terms: "بالمعنى",
  persona: "الشريحة",
  signal: "إشارة",
};

const PAGE = 100;
const SOURCE: Record<string, string> = {
  business_button: "زر التواصل",
  bio: "البايو",
  link: "الرابط",
  website: "موقعه",
  account: "حساب آخر له",
};
const FLAGS: Record<string, string> = {
  low_engagement: "تفاعل منخفض",
  suspicious_engagement: "تفاعل مريب",
  follow_farming: "متابعة متبادلة",
  few_posts: "منشورات قليلة",
};
const STATUSES = ["new", "contacted", "interested", "customer", "rejected"] as const;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const q = await searchParams;
  const rt = await getRuntime();
  const projects = await rt.scrapers.listProjects();
  const projectId = q.project ?? projects[0]?.id;
  const project = projects.find((p) => p.id === projectId);
  if (!projectId || !project) return <Notice tone="info">لا توجد مشاريع بعد.</Notice>;

  const status = STATUSES.find((s) => s === q.status);
  const minScore = q.min_score ? Number(q.min_score) : undefined;
  const country =
    q.country && /^[A-Za-z]{2}$/.test(q.country) ? q.country.toUpperCase() : undefined;
  const language = q.language && /^[a-z]{2}$/.test(q.language) ? q.language : undefined;
  const minSources = q.min_sources ? Number(q.min_sources) : undefined;
  // A question in plain language: the AI turns it into filters.
  let asked: { query: Record<string, unknown>; error?: string } | null = null;
  let askedRows: Awaited<ReturnType<typeof rt.scrapers.askLeads>>["leads"] | null = null;
  if (q.ask?.trim()) {
    try {
      const r = await rt.scrapers.askLeads(projectId, q.ask, PAGE);
      asked = { query: r.query as Record<string, unknown> };
      askedRows = r.leads;
    } catch (err) {
      asked = {
        query: {},
        error: /ANTHROPIC_API_KEY/.test((err as Error).message)
          ? "الأسئلة بالعربي تحتاج ANTHROPIC_API_KEY في Vercel."
          : `تعذّر فهم السؤال: ${(err as Error).message}`,
      };
    }
  }
  const [page, counts, monitors, platformCounts] = await Promise.all([
    rt.scrapers.listLeadsPage({
      projectId,
      ...(q.job ? { jobId: q.job } : {}),
      ...(q.business ? { business: true } : {}),
      ...(q.has_email ? { hasEmail: true } : {}),
      ...(q.has_phone ? { hasPhone: true } : {}),
      ...(minScore !== undefined && !Number.isNaN(minScore) ? { minScore } : {}),
      ...(status ? { status } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(country ? { country } : {}),
      ...(language ? { language } : {}),
      ...(minSources && minSources > 1 ? { minSources } : {}),
      ...(q.persona ? { persona: q.persona } : {}),
      ...(q.platform && q.platform in PLATFORM_LABELS ? { platform: q.platform } : {}),
      ...(q.signal === "rising" || q.signal === "became_business" ? { signal: q.signal } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      limit: PAGE,
    }),
    rt.scrapers.leadStatusCounts(projectId),
    rt.scrapers.listMonitors(projectId),
    rt.scrapers.platformCounts(projectId),
  ]);
  const rows = askedRows ?? page.leads;
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);

  const base = Object.fromEntries(
    Object.entries({ ...q, project: projectId }).filter(
      (e): e is [string, string] => !!e[1] && e[0] !== "cursor" && e[0] !== "ask",
    ),
  );
  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(base);
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    return `/leads?${p}`;
  };
  const exportHref = (format: string) =>
    `/api/export?${new URLSearchParams(base)}&format=${format}`;
  const sheets = integrationStatus().sheets;

  return (
    <>
      <Card title="تصفية وبحث" icon="search">
        <form className="grid gap-3 sm:grid-cols-6" method="get">
          <Select name="project" defaultValue={projectId} className="sm:col-span-2">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Input
            name="q"
            defaultValue={q.q}
            placeholder="ابحث في المعرّف أو الاسم أو البايو"
            className="sm:col-span-3"
          />
          <Input
            name="min_score"
            type="number"
            min={0}
            max={100}
            placeholder="أدنى درجة"
            defaultValue={q.min_score}
          />
          {q.job && <input type="hidden" name="job" value={q.job} />}
          {status && <input type="hidden" name="status" value={status} />}
          <Select name="country" defaultValue={country ?? ""} aria-label="الدولة">
            <option value="">كل الدول</option>
            {Object.entries(COUNTRIES).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
          <Select name="language" defaultValue={language ?? ""} aria-label="اللغة">
            <option value="">كل اللغات</option>
            {Object.entries(LANGUAGE_LABELS).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
          {project.personas?.length ? (
            <Select name="persona" defaultValue={q.persona ?? ""} aria-label="الشريحة">
              <option value="">كل الشرائح</option>
              {project.personas.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="signal"
              value="rising"
              defaultChecked={q.signal === "rising"}
            />{" "}
            ينمو بسرعة
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              name="min_sources"
              value="2"
              defaultChecked={(minSources ?? 0) >= 2}
            />{" "}
            يتابع أكثر من منافس
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="business" value="1" defaultChecked={!!q.business} /> تجاري
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="has_email" value="1" defaultChecked={!!q.has_email} /> له
            إيميل
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="has_phone" value="1" defaultChecked={!!q.has_phone} /> له
            رقم
          </label>
          <Button type="submit" className="sm:col-start-6">
            تطبيق
          </Button>
        </form>
        <form method="get" className="mt-4 flex flex-wrap gap-2">
          <input type="hidden" name="project" value={projectId} />
          <Input
            name="ask"
            defaultValue={q.ask}
            placeholder="اسأل بالعربي: المهتمون من الكويت فوق 5000 متابع ولهم رقم"
            className="min-w-0 flex-1"
            aria-label="اسأل عن عملائك"
          />
          <Button type="submit">اسأل</Button>
        </form>
        {Object.keys(platformCounts).length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs text-muted">لهم حساب على:</span>
            {Object.entries(platformCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([pl, n]) => (
                <Link
                  key={pl}
                  href={href({ platform: q.platform === pl ? undefined : pl })}
                  className={cx(
                    "rounded-full px-3 py-1",
                    q.platform === pl ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2",
                  )}
                >
                  {PLATFORM_LABELS[pl as Platform] ?? pl} {n}
                </Link>
              ))}
          </div>
        )}
        {asked?.error && (
          <div className="mt-3">
            <Notice tone="warn">{asked.error}</Notice>
          </div>
        )}
        {asked && !asked.error && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted">فهمت السؤال هكذا:</span>
            {Object.entries(asked.query).map(([k, v]) => (
              <Badge key={k} tone="accent" dot={false}>
                {QUERY_LABELS[k] ?? k}: {String(v === true ? "نعم" : v)}
              </Badge>
            ))}
            {Object.keys(asked.query).length === 0 && <span>بدون شروط (كل العملاء)</span>}
            <Link href={href({})} className="text-accent hover:underline">
              إلغاء السؤال
            </Link>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2 text-sm">
          <Link
            href={href({ status: undefined })}
            className={cx(
              "rounded-full px-3 py-1",
              !status ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2",
            )}
          >
            الكل {total}
          </Link>
          {STATUSES.map((s) => (
            <Link
              key={s}
              href={href({ status: s })}
              className={cx(
                "rounded-full px-3 py-1",
                status === s ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2",
              )}
            >
              {STATUS_LABELS[s]} {counts[s] ?? 0}
            </Link>
          ))}
        </div>
      </Card>

      <Card
        title={`العملاء${q.job ? " (مهمة واحدة)" : ""}`}
        icon="users"
        description="التصدير يشمل كل العملاء المطابقين مع درجتهم وحالتهم."
        actions={
          <div className="flex gap-2">
            <LinkButton href={`/leads/board?project=${projectId}`}>لوحة الأعمدة</LinkButton>
            <LinkButton href={exportHref("xlsx")}>Excel</LinkButton>
            <LinkButton href={exportHref("csv")}>CSV</LinkButton>
          </div>
        }
      >
        {rows.length > 0 && (
          <ActionForm
            id="bulk"
            action={bulkLeads}
            submit="طبّق على المحدد"
            className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-bg-2 p-2 text-sm"
          >
            <input type="hidden" name="project" value={projectId} />
            <span className="text-muted">للمحدد:</span>
            <Select name="bulk_status" defaultValue="" aria-label="حالة المحدد" className="w-auto">
              <option value="">— الحالة —</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
            <Input
              type="date"
              name="bulk_day"
              aria-label="تاريخ متابعة للمحدد"
              className="ltr w-auto"
            />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" name="bulk_clear" /> إلغاء التذكير
            </label>
          </ActionForm>
        )}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">لا توجد نتائج.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[12.5px] text-muted">
                  <th className="w-6 py-2 pe-2">
                    <SelectAll form="bulk" />
                  </th>
                  {[
                    "الحساب",
                    "المتابعون",
                    "الإيميل",
                    "الهاتف",
                    "المصدر",
                    "الدرجة",
                    "الحالة",
                    "متابعة",
                  ].map((h) => (
                    <th key={h} className="px-2 py-2 text-start font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.username} className="border-b border-line align-top last:border-0">
                    <td className="py-2.5 pe-2">
                      <input
                        type="checkbox"
                        name="u"
                        value={r.username}
                        form="bulk"
                        aria-label={`تحديد @${r.username}`}
                      />
                    </td>
                    <td className="px-2 py-2.5">
                      <a
                        href={`https://www.instagram.com/${r.username}/`}
                        target="_blank"
                        rel="noreferrer"
                        className="ltr font-medium text-accent hover:underline"
                      >
                        @{r.username}
                      </a>
                      <Link
                        href={`/leads/${r.username}?project=${projectId}`}
                        className="ms-2 text-xs text-muted hover:text-accent"
                      >
                        التفاصيل
                      </Link>
                      <div className="text-xs text-muted">
                        {[r.fullName, r.category, r.city, r.isBusiness ? "تجاري" : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.qualityFlags?.map((f) => (
                          <Badge key={f} tone="warn" dot={false}>
                            {FLAGS[f] ?? f}
                          </Badge>
                        ))}
                        {r.persona && (
                          <Badge tone="accent" dot={false}>
                            {r.persona}
                          </Badge>
                        )}
                        {r.signals?.includes("rising") && (
                          <Badge tone="ok" dot={false}>
                            ينمو بسرعة
                          </Badge>
                        )}
                        {r.dealValue != null && (
                          <Badge tone="ok" dot={false}>
                            صفقة ${r.dealValue.toLocaleString("en")}
                          </Badge>
                        )}
                        {(r.sourceCount ?? 1) > 1 && (
                          <Badge tone="ok" dot={false}>
                            عند {r.sourceCount} منافسين
                          </Badge>
                        )}
                        {r.country && (
                          <Badge tone="plain" dot={false}>
                            {COUNTRIES[r.country] ?? r.country}
                          </Badge>
                        )}
                        {r.language && (
                          <Badge tone="plain" dot={false}>
                            {LANGUAGE_LABELS[r.language] ?? r.language}
                          </Badge>
                        )}
                        {r.otherProjects > 0 && (
                          <Badge tone="info" dot={false}>
                            في {r.otherProjects} مشروع آخر
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 tabular-nums">
                      {fmtNum(r.followers)}
                      {r.engagementRate !== null && (
                        <div className="text-xs text-muted">
                          تفاعل {r.engagementRate.toFixed(1)}%
                        </div>
                      )}
                    </td>
                    <td className="ltr px-2 py-2.5">{r.email ?? "—"}</td>
                    <td className="px-2 py-2.5">
                      <span className="ltr">{r.phone ?? "—"}</span>
                      {r.phone && !r.phoneConfirmed && (
                        <span className="ms-1 text-xs text-warn">غير مؤكد</span>
                      )}
                      {r.phoneCountry && (
                        <span className="ms-1 text-xs text-muted">{r.phoneCountry}</span>
                      )}
                      {(() => {
                        const wa = waLink(
                          r.phone,
                          r.phoneConfirmed,
                          fillTemplate(project.messageTemplate, r),
                        );
                        return wa ? (
                          <a
                            href={wa}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 block text-xs text-ok hover:underline"
                          >
                            واتساب ←
                          </a>
                        ) : null;
                      })()}
                    </td>
                    <td className="px-2 py-2.5 text-xs">
                      {r.contactSource ? SOURCE[r.contactSource] : "—"}
                    </td>
                    <td className="px-2 py-2.5" title={r.aiReason ?? undefined}>
                      {r.aiScore ?? "—"}
                      {r.aiTags && <div className="text-xs text-muted">{r.aiTags.join("، ")}</div>}
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusSelect projectId={projectId} username={r.username} status={r.status} />
                      {r.statusNote && (
                        <div className="mt-1 text-xs text-muted">{r.statusNote}</div>
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      <FollowUpInput
                        projectId={projectId}
                        username={r.username}
                        at={r.followUpAt}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex gap-2">
          {q.cursor && <LinkButton href={href({})}>من البداية</LinkButton>}
          {!askedRows && page.nextCursor && (
            <LinkButton href={`${href({})}&cursor=${encodeURIComponent(page.nextCursor)}`}>
              التالي
            </LinkButton>
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`إعدادات ${project.name}`} icon="settings">
          <ActionForm action={updateProjectSettings} submit="حفظ">
            <input type="hidden" name="project" value={projectId} />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="auto_export"
                defaultChecked={project.autoExport}
                className="mt-1"
              />
              <span>
                تصدير تلقائي: عند انتهاء كل مهمة يُضاف <b>كل</b> العملاء مع درجتهم وحالتهم إلى شيت
                المشروع.
                {!sheets && (
                  <span className="block text-xs text-warn">
                    يحتاج GOOGLE_SERVICE_ACCOUNT_JSON.
                  </span>
                )}
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="skip_fake"
                defaultChecked={project.skipFake}
                className="mt-1"
              />
              <span>
                تجاهل الحسابات الوهمية: لا يُحفظ حساب فيه علامتان أو أكثر (متابعة متبادلة، منشورات
                قليلة، تفاعل مريب) وليس له وسيلة تواصل.
              </span>
            </label>
            <Field
              label="شيت المشروع (اختياري)"
              hint="فارغ = يُنشأ شيت جديد عند أول تصدير تلقائي ويُحفظ هنا."
            >
              <Input name="sheet" defaultValue={project.sheetId ?? ""} className="ltr" />
            </Field>
            <Field
              label="معايير التقييم"
              hint="إذا كُتبت والذكاء الاصطناعي مفعّل، تُقيَّم كل مهمة تلقائياً قبل التصدير."
            >
              <Textarea name="criteria" defaultValue={project.aiCriteria ?? ""} />
            </Field>
            <Field
              label="قالب رسالة واتساب"
              hint="يُستخدم في روابط واتساب لكل عميل. {name} = اسمه، {username} = معرّفه. أنت من يضغط إرسال."
            >
              <Textarea
                name="template"
                defaultValue={project.messageTemplate ?? ""}
                placeholder="مرحباً {name}، أعجبني محتوى حسابك @{username}…"
              />
            </Field>
            <Field
              label="كلمات المراقبة"
              hint="مفصولة بفواصل. يصلك تنبيه إذا ظهرت في اسم أو بايو أي حساب يُجمع."
            >
              <Input
                name="keywords"
                defaultValue={project.watchKeywords?.join("، ") ?? ""}
                placeholder="وكيل، IB، شراكة"
              />
            </Field>
          </ActionForm>
        </Card>

        <Card
          title="الحسابات في المنصات الأخرى"
          icon="plug"
          description="يبحث في بايو وروابط كل عملاء المشروع عن حساباتهم في تيك توك ويوتيوب وتلكرام وX ومواقعهم، ويربطها بهم. الجدد يُربطون تلقائياً."
        >
          <ActionForm action={linkProjectAccounts} submit="اربط حسابات العملاء الحاليين">
            <input type="hidden" name="project" value={projectId} />
          </ActionForm>
        </Card>

        <Card
          title="مراقبة المنافسين"
          icon="radar"
          description="مهمة متكررة تجمع الحسابات الجديدة فقط. تعمل مع المهمة اليومية."
        >
          {monitors.length > 0 && (
            <ul className="mb-4 divide-y divide-line text-sm">
              {monitors.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <span className="ltr min-w-0 flex-1 truncate">{m.sourceUrl}</span>
                  <span className="text-xs text-muted">
                    كل {m.everyDays} يوم · آخر تشغيل {fmtDate(m.lastRunAt)}
                  </span>
                  <form action={toggleMonitor.bind(null, m.id, !m.enabled)}>
                    <Button variant="default" type="submit" className="px-2.5 py-1 text-xs">
                      {m.enabled ? "إيقاف" : "تشغيل"}
                    </Button>
                  </form>
                  <form action={removeMonitor.bind(null, m.id)}>
                    <Button variant="danger" type="submit" className="px-2.5 py-1 text-xs">
                      حذف
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={addMonitor} submit="أضف مراقبة">
            <input type="hidden" name="project" value={projectId} />
            <Field label="حساب منافس أو منشور أو هاشتاق">
              <Input
                name="source"
                required
                className="ltr"
                placeholder="https://instagram.com/competitor"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="كل كم يوم">
                <Input name="every" type="number" min={1} max={90} defaultValue={7} />
              </Field>
              <Field label="الحد الأقصى">
                <Input name="limit" type="number" min={1} max={1000} defaultValue={100} />
              </Field>
            </div>
          </ActionForm>
        </Card>
      </div>

      <Card title="إيقاف شخص وحذف بياناته" icon="shield">
        <ActionForm
          action={suppress}
          submit="إيقاف"
          className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-start"
        >
          <Select name="kind" defaultValue="username">
            <option value="username">معرّف</option>
            <option value="email">إيميل</option>
            <option value="phone">هاتف</option>
          </Select>
          <Input name="value" required className="ltr" placeholder="@username" />
        </ActionForm>
      </Card>
    </>
  );
}
