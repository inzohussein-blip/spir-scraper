import Link from "next/link";
import { createEngineRun, saveEngineSettings, setEngineRunStatus } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import {
  Badge,
  Card,
  Field,
  fmtAgo,
  fmtDate,
  fmtNum,
  Input,
  Kpi,
  Notice,
  Select,
  Textarea,
} from "@/components/ui";
import { appOrigin } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "محرك Spir" };

const STATE: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "info" | "plain" }> = {
  running: { label: "يعمل", tone: "ok" },
  idle: { label: "جاهز، لا يوجد ما يقرأه", tone: "info" },
  resting: { label: "يستريح بطلب من إنستقرام", tone: "warn" },
  quiet: { label: "ساعات الراحة", tone: "info" },
  daily_cap: { label: "بلغ حد اليوم", tone: "info" },
  paused: { label: "متوقف", tone: "plain" },
  no_worker: { label: "لا يوجد جهاز متصل", tone: "bad" },
};

const RUN_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "plain" | "info" }> = {
  active: { label: "يعمل", tone: "ok" },
  paused: { label: "موقوف مؤقتاً", tone: "warn" },
  done: { label: "انتهى", tone: "info" },
  stopped: { label: "أُنهي", tone: "plain" },
};

export default async function EnginePage() {
  const rt = await getRuntime();
  const [status, runs, events, projects] = await Promise.all([
    rt.scrapers.engineStatus(),
    rt.scrapers.listEngineRuns(30),
    rt.scrapers.engineEvents(12),
    rt.scrapers.listProjects(),
  ]);
  const s = status.settings;
  const perHour = Math.round(3600 / (s.intervalSec + s.jitterSec / 2));
  const state = STATE[status.state] ?? { label: status.state, tone: "plain" as const };

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-3 p-5">
        <div className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-2 text-lg font-bold text-white">
          S
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold">محرك Spir</h1>
          <p className="text-sm text-muted">
            يقرأ الحسابات العامة ببطء من جهازك في البيت، بلا تسجيل دخول وبلا تكلفة: يبدأ من حسابات
            تختارها، ثم يتبع من يذكرونهم ما دام في مجالك.
          </p>
        </div>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>

      {status.state === "no_worker" && (
        <Notice tone="info">
          لم يتصل جهاز البيت بعد. شغّل العامل المنزلي بأمر المحرك (الشرح في docs/HOME-WORKER.md، قسم
          «محرك Spir»)، مع <span className="ltr font-mono">PLATFORM_URL={appOrigin()}</span> ونفس{" "}
          <span className="ltr font-mono">WORKER_SHARED_SECRET</span> الموجود في Vercel.
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="قُرئ آخر 24 ساعة"
          value={fmtNum(status.readToday)}
          hint={`الحد ${fmtNum(s.dailyCap)}`}
          icon="activity"
        />
        <Kpi label="في الطابور" value={fmtNum(status.queued)} icon="users" />
        <Kpi
          label="السرعة"
          value={`~${perHour}/ساعة`}
          hint={`حساب كل ${s.intervalSec}–${s.intervalSec + s.jitterSec} ثانية`}
          icon="chart"
        />
        <Kpi
          label="آخر اتصال للجهاز"
          value={status.workerLastSeen ? fmtAgo(status.workerLastSeen) : "—"}
          hint={status.restingUntil ? `يعود ${fmtDate(status.restingUntil)}` : undefined}
          icon="plug"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card
          title="تشغيل جديد"
          icon="plus"
          description="مثل أدوات Apify، لكن مجاناً وببطء: اختر من أين يبدأ، وما الذي يقبله، وإلى أين يذهب."
        >
          {projects.length === 0 ? (
            <Notice tone="info">أنشئ مشروعاً أولاً.</Notice>
          ) : (
            <ActionForm action={createEngineRun} submit="ابدأ التشغيل" className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="الاسم">
                  <Input name="name" placeholder="مدربو التداول في الخليج" required />
                </Field>
                <Field label="المشروع (يُرسل له المقبولون)">
                  <Select name="project" defaultValue={projects[0]?.id}>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="النوع">
                <Select name="mode" defaultValue="crawl">
                  <option value="crawl">زحف: ابدأ من هذه الحسابات واتبع من يذكرونهم</option>
                  <option value="list">قراءة قائمة: اقرأ هذه الحسابات فقط</option>
                </Select>
              </Field>
              <Field
                label="الحسابات (سطر أو فاصلة لكل حساب)"
                hint="منافسون، أو أفضل عملائك، أو قائمة تريد قراءتها مجاناً."
              >
                <Textarea
                  name="seeds"
                  className="ltr"
                  rows={4}
                  placeholder={"@competitor1\n@best_customer"}
                  required
                />
              </Field>
              <Field
                label="كلمات المجال (اختياري)"
                hint="يُقبل الحساب إن ظهرت إحداها في اسمه أو البايو أو منشوراته، ولا يُتبع من يذكرهم إن لم تظهر. فارغ: الكل."
              >
                <Input name="keywords" placeholder="تداول، فوركس، ذهب، trading" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="العمق" hint="1: من تذكرهم البذور. 2: ومن يذكرهم هؤلاء.">
                  <Input name="depth" type="number" min={0} max={5} defaultValue={2} />
                </Field>
                <Field label="أقصى عدد حسابات">
                  <Input name="max" type="number" min={1} max={50000} defaultValue={500} />
                </Field>
                <Field label="أقل عدد متابعين">
                  <Input name="min_followers" type="number" min={0} defaultValue={0} />
                </Field>
              </div>
            </ActionForm>
          )}
        </Card>

        <Card
          title="السرعة والراحة"
          icon="settings"
          description="تنطبق على كل التشغيلات. الأبطأ أكثر أماناً لعنوان بيتك."
        >
          <ActionForm action={saveEngineSettings} submit="حفظ" className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={s.enabled} />
              المحرك يعمل
            </label>
            <div className="grid grid-cols-2 gap-3">
              <Field label="ثوانٍ بين الحسابات" hint="20 على الأقل">
                <Input
                  name="interval"
                  type="number"
                  min={20}
                  max={3600}
                  defaultValue={s.intervalSec}
                />
              </Field>
              <Field label="عشوائية (ثوانٍ)">
                <Input name="jitter" type="number" min={0} max={600} defaultValue={s.jitterSec} />
              </Field>
            </div>
            <Field label="حد يومي">
              <Input name="daily_cap" type="number" min={1} max={5000} defaultValue={s.dailyCap} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="راحة من الساعة">
                <Input
                  name="quiet_from"
                  type="number"
                  min={0}
                  max={23}
                  defaultValue={s.quietFrom}
                />
              </Field>
              <Field label="إلى الساعة" hint="نفس الرقم: بلا راحة">
                <Input name="quiet_to" type="number" min={0} max={23} defaultValue={s.quietTo} />
              </Field>
            </div>
          </ActionForm>
        </Card>
      </div>

      <Card title="التشغيلات" icon="folder">
        {runs.length === 0 ? (
          <p className="text-sm text-muted">لا توجد تشغيلات بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[12.5px] text-muted">
                  {["التشغيل", "الحالة", "قُرئ", "قُبل", "تُخطي", "البدء", ""].map((h) => (
                    <th key={h} className="px-2 py-2 text-start font-medium first:ps-0">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const st = RUN_STATUS[r.status] ?? { label: r.status, tone: "plain" as const };
                  return (
                    <tr key={r.id} className="border-b border-line last:border-0">
                      <td className="py-2.5 pe-2">
                        <Link
                          href={`/engine/${r.id}`}
                          className="font-medium text-accent hover:underline"
                        >
                          {r.name}
                        </Link>
                        <div className="text-xs text-muted">
                          {r.maxDepth === 0 ? "قراءة قائمة" : `زحف بعمق ${r.maxDepth}`} · حتى{" "}
                          {fmtNum(r.maxAccounts)}
                        </div>
                      </td>
                      <td className="px-2">
                        <Badge tone={st.tone} dot={false}>
                          {st.label}
                        </Badge>
                      </td>
                      <td className="px-2 tabular-nums">{fmtNum(r.counts.read ?? 0)}</td>
                      <td className="px-2 tabular-nums">{fmtNum(r.counts.accepted ?? 0)}</td>
                      <td className="px-2 tabular-nums">{fmtNum(r.counts.skipped ?? 0)}</td>
                      <td className="px-2 text-xs text-muted">{fmtDate(r.createdAt)}</td>
                      <td className="px-2">
                        <div className="flex gap-1">
                          {r.status === "active" && (
                            <form action={setEngineRunStatus.bind(null, r.id, "paused")}>
                              <button
                                type="submit"
                                className="rounded px-2 py-0.5 text-xs text-muted hover:bg-bg-2"
                              >
                                إيقاف مؤقت
                              </button>
                            </form>
                          )}
                          {r.status === "paused" && (
                            <form action={setEngineRunStatus.bind(null, r.id, "active")}>
                              <button
                                type="submit"
                                className="rounded px-2 py-0.5 text-xs text-accent hover:bg-accent-soft"
                              >
                                استئناف
                              </button>
                            </form>
                          )}
                          {(r.status === "active" || r.status === "paused") && (
                            <form action={setEngineRunStatus.bind(null, r.id, "stopped")}>
                              <button
                                type="submit"
                                className="rounded px-2 py-0.5 text-xs text-bad hover:bg-bad-soft"
                              >
                                إنهاء
                              </button>
                            </form>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
  );
}
