import { JobNotFoundError } from "@scrapers/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buildReport, cancelJob, deepContacts, exportToSheet, scoreJob } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Icon, type IconName } from "@/components/icons";
import {
  Button,
  Card,
  cx,
  Field,
  fmtDate,
  fmtNum,
  LinkButton,
  Notice,
  Progress,
  Select,
  Stat,
  StatusBadge,
  Textarea,
} from "@/components/ui";
import { integrationStatus } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";

type StepState = "done" | "active" | "idle" | "failed";

/** The job's path, like the bot panel's flow map: each stage with its count and state. */
function Flow({
  steps,
}: {
  steps: { label: string; icon: IconName; value: string; state: StepState; note?: string }[];
}) {
  const ring: Record<StepState, string> = {
    done: "border-ok/40 bg-ok-soft text-ok",
    active: "border-warn/40 bg-warn-soft text-warn",
    idle: "border-line bg-surface-2 text-muted",
    failed: "border-bad/40 bg-bad-soft text-bad",
  };
  return (
    <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {steps.map((s, i) => (
        <li key={s.label} className="relative">
          <div className={cx("h-full rounded-[12px] border p-3", ring[s.state])}>
            <div className="flex items-center gap-2 text-[12.5px] font-medium">
              <Icon name={s.icon} className={cx("size-4", s.state === "active" && "pulse")} />
              {s.label}
            </div>
            <div className="mt-1 text-xl font-bold text-fg tabular-nums">{s.value}</div>
            {s.note && <div className="text-[11.5px] text-fg-2">{s.note}</div>}
          </div>
          {i < steps.length - 1 && (
            <Icon
              name="arrow"
              className="absolute top-1/2 -end-3 z-10 hidden size-4 -translate-y-1/2 text-muted lg:block"
            />
          )}
        </li>
      ))}
    </ol>
  );
}

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rt = await getRuntime();
  let job: Awaited<ReturnType<typeof rt.scrapers.getJob>>;
  try {
    job = await rt.scrapers.getJob(id);
  } catch (err) {
    if (err instanceof JobNotFoundError) notFound();
    throw err;
  }
  const [project, contacts, waiting, deepResult] = await Promise.all([
    rt.scrapers.getProject(job.projectId),
    rt.scrapers.jobContactCounts(job.id),
    rt.scrapers.deepContactCandidates({ jobId: job.id }),
    rt.scrapers.jobDeepResult(job.id),
  ]);
  const running = job.status === "queued" || job.status === "running";
  const active = running || !!job.counts.aiBatchId;
  const c = job.counts;
  const status = integrationStatus();
  const exportBase = `/api/export?project=${job.projectId}&job=${job.id}`;
  const processed = (c.enriched ?? 0) + (c.skipped ?? 0) + (c.failed ?? 0);
  const discoveryState: StepState =
    job.status === "failed" && !c.discovered
      ? "failed"
      : c.discovered !== undefined
        ? "done"
        : running
          ? "active"
          : "idle";
  const enrichState: StepState = !c.discovered
    ? "idle"
    : processed >= c.discovered
      ? "done"
      : job.status === "running"
        ? "active"
        : "idle";

  return (
    <>
      <AutoRefresh active={active} />
      <Card
        icon="radar"
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="ltr">{job.sourceUrl}</span>
            <StatusBadge status={job.status} />
          </span>
        }
        description={
          <>
            المشروع:{" "}
            <Link className="underline" href={`/leads?project=${job.projectId}&job=${job.id}`}>
              {project?.name}
            </Link>{" "}
            · بدأت {fmtDate(job.startedAt)} · انتهت {fmtDate(job.finishedAt)}
          </>
        }
        actions={
          running && (
            <form action={cancelJob.bind(null, job.id)}>
              <Button variant="danger" type="submit">
                إلغاء
              </Button>
            </form>
          )
        }
      >
        <div className="space-y-4">
          <Progress value={job.progress} />
          {c.viaEngine ? (
            <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm">
              {fmtNum(c.viaEngine)} حساب تُقرأ مجاناً عبر محرك Spir، حساباً كل دقيقة تقريباً، وتصل
              للعملاء على دفعات.{" "}
              <a href="/engine" className="font-medium text-accent hover:underline">
                تابعها في صفحة المحرك
              </a>
            </p>
          ) : null}
          <Flow
            steps={[
              {
                label: "المصدر",
                icon: "radar",
                value: job.sourceType,
                state: "done",
                note: job.provider ? `عبر ${job.provider}` : undefined,
              },
              {
                label: "الاكتشاف",
                icon: "search",
                value: fmtNum(c.discovered ?? 0),
                state: discoveryState,
                note: "حساب",
              },
              {
                label: "الجلب",
                icon: "download",
                value: fmtNum(c.enriched ?? 0),
                state: enrichState,
                note: `تُخطّيت ${fmtNum(c.skipped ?? 0)} · فشلت ${fmtNum(c.failed ?? 0)}`,
              },
              {
                label: "وسيلة تواصل",
                icon: "users",
                value: fmtNum(c.leads ?? 0),
                state: c.leads ? "done" : "idle",
                note: "إيميل أو رقم",
              },
              {
                label: "التقييم",
                icon: "sparkles",
                value: fmtNum(c.scored ?? 0),
                state: c.aiBatchId ? "active" : c.scored ? "done" : "idle",
                note: c.aiBatchId ? "دفعة قيد المعالجة" : undefined,
              },
              {
                label: "التصدير",
                icon: "sheet",
                value: "↓",
                state: job.status === "done" ? "done" : "idle",
                note: "Excel · CSV · Sheets",
              },
            ]}
          />
          {job.error && <Notice tone="error">{job.error}</Notice>}
        </div>
      </Card>

      {contacts.total > 0 && (
        <Card
          title="الإيميل والرقم"
          icon="users"
          description="وسائل التواصل العامة لعملاء هذه المهمة، والبحث العميق لمن ليس له شيء."
        >
          <div className="grid grid-cols-3 gap-3">
            <Stat label="العملاء" value={contacts.total} />
            <Stat label="لهم إيميل" value={contacts.email} />
            <Stat label="لهم رقم" value={contacts.phone} />
          </div>
          {deepResult && (
            <p className="mt-3 text-sm text-fg-2">
              البحث العميق التلقائي: بُحث عن {deepResult.checked} حساب، ووُجد {deepResult.emails}{" "}
              إيميل و{deepResult.phones} رقم.
            </p>
          )}
          {!running && waiting > 0 && (
            <ActionForm action={deepContacts} submit={`ابحث عن الإيميل والرقم (${waiting})`}>
              <input type="hidden" name="job" value={job.id} />
              <p className="text-sm text-fg-2">
                {waiting} حساب تجاري أو كبير بلا إيميل ولا رقم: يُبحث في موقعه وصفحة «تواصل معنا»
                وحساباته الأخرى.
              </p>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="reread" className="mt-1" />
                <span>قراءة ثانية عبر Apify أولاً (≈ ${((waiting * 1.6) / 1000).toFixed(2)})</span>
              </label>
            </ActionForm>
          )}
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="تصدير" icon="download">
          <div className="mb-4 flex flex-wrap gap-2">
            <LinkButton href={`${exportBase}&format=xlsx`}>Excel</LinkButton>
            <LinkButton href={`${exportBase}&format=csv`}>CSV</LinkButton>
            <LinkButton href={`/leads?project=${job.projectId}&job=${job.id}`}>
              عرض العملاء
            </LinkButton>
          </div>
          {status.sheets ? (
            <ActionForm action={exportToSheet} submit="إلى Google Sheets">
              <input type="hidden" name="project" value={job.projectId} />
              <input type="hidden" name="job" value={job.id} />
              <Field label="الطريقة">
                <Select name="mode" defaultValue={project?.sheetId ? "append" : "new-file"}>
                  <option value="new-file">شيت جديد</option>
                  <option value="new-tab" disabled={!project?.sheetId}>
                    تبويب جديد في شيت المشروع
                  </option>
                  <option value="append" disabled={!project?.sheetId}>
                    إضافة إلى شيت المشروع
                  </option>
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="business" /> الحسابات التجارية فقط
              </label>
            </ActionForm>
          ) : (
            <p className="text-sm text-muted">
              لتفعيل Google Sheets أضف GOOGLE_SERVICE_ACCOUNT_JSON، أو اطلب من Claude كتابة النتائج
              عبر موصّل Sheets.
            </p>
          )}
        </Card>

        <Card title="الذكاء الاصطناعي" icon="sparkles">
          {status.ai ? (
            <div className="space-y-5">
              <ActionForm action={scoreJob} submit="قيّم العملاء">
                <input type="hidden" name="job" value={job.id} />
                <Field label="معايير التقييم">
                  <Textarea
                    name="criteria"
                    defaultValue={c.aiCriteria ?? project?.aiCriteria ?? ""}
                    required
                    minLength={3}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="rescore" /> أعد تقييم من سبق تقييمه
                </label>
              </ActionForm>
              <ActionForm action={buildReport} submit="اكتب تقرير الجمهور">
                <input type="hidden" name="job" value={job.id} />
              </ActionForm>
            </div>
          ) : (
            <p className="text-sm text-muted">
              أضف ANTHROPIC_API_KEY للتقييم من هنا، أو اطلب من Claude عبر MCP أن يقيّم العملاء بنفسه
              بدون مفتاح.
            </p>
          )}
        </Card>
      </div>

      {c.report && (
        <Card title="تقرير الجمهور" icon="chart">
          <div className="whitespace-pre-wrap text-sm leading-7">{c.report}</div>
        </Card>
      )}
    </>
  );
}
