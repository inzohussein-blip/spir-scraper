import { JobNotFoundError } from "@scrapers/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buildReport, cancelJob, exportToSheet, scoreJob } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  Button,
  Card,
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
  const project = await rt.scrapers.getProject(job.projectId);
  const active = job.status === "queued" || job.status === "running" || !!job.counts.aiBatchId;
  const c = job.counts;
  const status = integrationStatus();
  const exportBase = `/api/export?project=${job.projectId}&job=${job.id}`;

  return (
    <>
      <AutoRefresh active={active} />
      <Card
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="ltr">{job.sourceUrl}</span>
            <StatusBadge status={job.status} />
          </span>
        }
        actions={
          (job.status === "queued" || job.status === "running") && (
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="مكتشفة" value={fmtNum(c.discovered ?? 0)} />
            <Stat label="جُلبت" value={fmtNum(c.enriched ?? 0)} />
            <Stat label="بوسيلة تواصل" value={fmtNum(c.leads ?? 0)} />
            <Stat label="تُخطّيت" value={fmtNum(c.skipped ?? 0)} />
            <Stat label="فشلت" value={fmtNum(c.failed ?? 0)} />
          </div>
          {job.error && <Notice tone="error">{job.error}</Notice>}
          {c.aiBatchId && (
            <Notice tone="info">
              التقييم بالذكاء الاصطناعي قيد المعالجة دفعةً واحدة. تتحدّث الصفحة تلقائياً.
            </Notice>
          )}
          <p className="text-xs text-[var(--muted)]">
            المشروع:{" "}
            <Link className="underline" href={`/leads?project=${job.projectId}&job=${job.id}`}>
              {project?.name}
            </Link>{" "}
            · المزوّد: {job.provider ?? "—"} · بدأت: {fmtDate(job.startedAt)} · انتهت:{" "}
            {fmtDate(job.finishedAt)}
          </p>
        </div>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="تصدير">
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
            <p className="text-sm text-[var(--muted)]">
              لتفعيل Google Sheets أضف GOOGLE_SERVICE_ACCOUNT_JSON، أو اطلب من Claude كتابة النتائج
              عبر موصّل Sheets.
            </p>
          )}
        </Card>

        <Card title="الذكاء الاصطناعي">
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
            <p className="text-sm text-[var(--muted)]">
              أضف ANTHROPIC_API_KEY للتقييم من هنا، أو اطلب من Claude عبر MCP أن يقيّم العملاء بنفسه
              بدون مفتاح.
            </p>
          )}
        </Card>
      </div>

      {c.report && (
        <Card title="تقرير الجمهور">
          <div className="whitespace-pre-wrap text-sm leading-7">{c.report}</div>
        </Card>
      )}
    </>
  );
}
