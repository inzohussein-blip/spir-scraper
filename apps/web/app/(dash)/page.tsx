import Link from "next/link";
import { createProject } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import {
  Badge,
  Card,
  Dot,
  Field,
  fmtAgo,
  fmtNum,
  Input,
  Kpi,
  Notice,
  Progress,
  StatusBadge,
  Table,
  Textarea,
} from "@/components/ui";
import { twoFactorEnabled } from "@/lib/auth";
import { integrationStatus } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";

const LEVEL_TONE = { ok: "ok", warn: "warn", bad: "bad", info: "plain" } as const;

export default async function Home() {
  const rt = await getRuntime();
  const [projects, jobs, stats, notes, twoFa] = await Promise.all([
    rt.scrapers.listProjects(),
    rt.scrapers.listJobs({ limit: 12 }),
    rt.scrapers.overviewStats(),
    rt.scrapers.listNotifications(6),
    twoFactorEnabled(),
  ]);
  const status = integrationStatus();
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const max = Math.max(1, ...stats.series.map((d) => d.leads));
  const dayName = (d: string) =>
    new Intl.DateTimeFormat("ar", { weekday: "short" }).format(new Date(d));

  // Setup reminders, like the bot panel's "no backup / 2FA off" warnings.
  const warnings: string[] = [];
  if (!status.worker && !status.apify && !status.graph)
    warnings.push("لا يوجد مصدر بيانات مفعّل: أضف APIFY_TOKEN أو WORKER_URL، وإلا ستفشل المهام.");
  if (!status.cron)
    warnings.push("CRON_SECRET غير مضبوط: المهام الطويلة لن تكمل نفسها، ولن يعمل الحذف التلقائي.");
  if (!twoFa)
    warnings.push(
      "التحقق بخطوتين مطفأ: أضف TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID ليصلك كود الدخول على تلكرام.",
    );

  return (
    <>
      {warnings.map((w) => (
        <Notice key={w} tone="warn">
          {w}
        </Notice>
      ))}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi
          label="كل العملاء"
          value={fmtNum(stats.leads)}
          icon="users"
          hint={`${fmtNum(stats.withContact)} بوسيلة تواصل`}
        />
        <Kpi label="قُيّموا بالذكاء الاصطناعي" value={fmtNum(stats.scored)} icon="sparkles" />
        <Kpi
          label="مهام اليوم"
          value={fmtNum(stats.jobsToday)}
          icon="radar"
          hint={stats.activeJobs ? `${stats.activeJobs} قيد التشغيل` : "لا شيء يعمل الآن"}
        />
        <Kpi label="مهام فشلت (7 أيام)" value={fmtNum(stats.failedJobs7d)} icon="activity" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card title="عملاء آخر 7 أيام" icon="chart">
          <div className="flex h-40 items-end gap-2">
            {stats.series.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1.5">
                <span className="text-[11px] text-muted tabular-nums">{d.leads || ""}</span>
                <div
                  className="w-full rounded-t-md bg-gradient-to-t from-accent to-accent-2"
                  style={{
                    height: `${Math.max(3, (d.leads / max) * 110)}px`,
                    opacity: d.leads ? 1 : 0.25,
                  }}
                  title={`${d.day}: ${d.leads}`}
                />
                <span className="text-[11px] text-muted">{dayName(d.day)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="آخر الإشعارات"
          icon="bell"
          actions={
            <Link href="/notifications" className="text-[13px] text-accent hover:underline">
              الكل
            </Link>
          }
        >
          {notes.length === 0 ? (
            <p className="text-sm text-muted">لا إشعارات بعد.</p>
          ) : (
            <ul className="space-y-3">
              {notes.map((n) => (
                <li key={n.id} className="flex items-start gap-2.5">
                  <span className="pt-1.5">
                    <Dot tone={n.level === "info" ? "plain" : (n.level as "ok" | "warn" | "bad")} />
                  </span>
                  <div className="min-w-0 flex-1">
                    {n.url ? (
                      <Link
                        href={n.url}
                        className="block truncate text-sm font-medium hover:text-accent"
                      >
                        {n.title}
                      </Link>
                    ) : (
                      <span className="block truncate text-sm font-medium">{n.title}</span>
                    )}
                    <span className="text-xs text-muted">{fmtAgo(n.at)}</span>
                  </div>
                  {!n.readAt && (
                    <Badge
                      tone={LEVEL_TONE[n.level as keyof typeof LEVEL_TONE] ?? "plain"}
                      dot={false}
                    >
                      جديد
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="آخر المهام"
        icon="radar"
        actions={
          <Link
            href="/jobs/new"
            className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline"
          >
            <Icon name="plus" className="size-4" /> مهمة جديدة
          </Link>
        }
      >
        {jobs.length === 0 ? (
          <p className="text-sm text-muted">لا توجد مهام بعد.</p>
        ) : (
          <Table head={["المصدر", "المشروع", "الحالة", "التقدّم", "بوسيلة تواصل", "متى"]}>
            {jobs.map((j) => {
              const c = j.counts;
              const done = (c.enriched ?? 0) + (c.skipped ?? 0) + (c.failed ?? 0);
              const progress = j.status === "done" ? 1 : c.discovered ? done / c.discovered : 0;
              return (
                <tr key={j.id}>
                  <td className="max-w-64 truncate">
                    <Link href={`/jobs/${j.id}`} className="ltr text-accent hover:underline">
                      {j.sourceUrl}
                    </Link>
                  </td>
                  <td>{names.get(j.projectId)}</td>
                  <td>
                    <StatusBadge status={j.status} />
                  </td>
                  <td className="w-40">
                    <Progress value={progress} />
                  </td>
                  <td className="tabular-nums">{fmtNum(c.leads ?? 0)}</td>
                  <td className="whitespace-nowrap text-muted">{fmtAgo(j.createdAt)}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="المشاريع" icon="folder">
          {projects.length === 0 ? (
            <p className="text-sm text-muted">أنشئ مشروعاً لتبدأ.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2.5">
                  <Link href={`/leads?project=${p.id}`} className="font-medium hover:text-accent">
                    {p.name}
                  </Link>
                  <span className="flex items-center gap-2 text-muted">
                    {p.sheetId && <Badge tone="ok">شيت مربوط</Badge>}
                    يحتفظ {p.retentionDays} يوماً
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="مشروع جديد" icon="plus">
          <ActionForm action={createProject} submit="إنشاء">
            <Field label="الاسم">
              <Input name="name" required maxLength={100} placeholder="وكلاء الخليج" />
            </Field>
            <Field label="مدة الاحتفاظ بالعملاء (أيام)">
              <Input name="retention" type="number" min={1} max={365} defaultValue={90} />
            </Field>
            <Field
              label="شيت Google موجود (اختياري)"
              hint="معرّف الشيت من رابطه. شاركه مع حساب الخدمة كمحرر."
            >
              <Input name="sheet" className="ltr" />
            </Field>
            <Field label="معايير التقييم بالذكاء الاصطناعي (اختياري)">
              <Textarea
                name="criteria"
                placeholder="وكيل محتمل في الخليج، يتحدث العربية، لديه جمهور مهتم بالتداول"
              />
            </Field>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
