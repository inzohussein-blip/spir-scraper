import Link from "next/link";
import { createProject } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import {
  Card,
  Field,
  fmtDate,
  fmtNum,
  Input,
  Notice,
  Progress,
  StatusBadge,
  Textarea,
} from "@/components/ui";
import { integrationStatus } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";

export default async function Home() {
  const rt = await getRuntime();
  const [projects, jobs] = await Promise.all([
    rt.scrapers.listProjects(),
    rt.scrapers.listJobs({ limit: 15 }),
  ]);
  const status = integrationStatus();
  const names = new Map(projects.map((p) => [p.id, p.name]));

  return (
    <>
      {!status.worker && !status.apify && (
        <Notice tone="warn">
          لا يوجد مصدر بيانات مفعّل. أضف <code>APIFY_TOKEN</code> (رصيد مجاني شهري) أو{" "}
          <code>WORKER_URL</code> لعامل Instaloader في إعدادات Vercel، وإلا ستفشل المهام.
        </Notice>
      )}

      <Card
        title="آخر المهام"
        actions={
          <Link href="/jobs/new" className="text-sm font-medium text-brand hover:underline">
            + مهمة جديدة
          </Link>
        }
      >
        {jobs.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">لا توجد مهام بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[var(--muted)]">
                <tr className="border-b border-[var(--line)] text-start">
                  <th className="py-2 text-start font-medium">المصدر</th>
                  <th className="py-2 text-start font-medium">المشروع</th>
                  <th className="py-2 text-start font-medium">الحالة</th>
                  <th className="w-40 py-2 text-start font-medium">التقدّم</th>
                  <th className="py-2 text-start font-medium">عملاء بتواصل</th>
                  <th className="py-2 text-start font-medium">التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const c = j.counts;
                  const done = (c.enriched ?? 0) + (c.skipped ?? 0) + (c.failed ?? 0);
                  const progress = j.status === "done" ? 1 : c.discovered ? done / c.discovered : 0;
                  return (
                    <tr key={j.id} className="border-b border-[var(--line)] last:border-0">
                      <td className="max-w-64 truncate py-2.5">
                        <Link href={`/jobs/${j.id}`} className="ltr text-brand hover:underline">
                          {j.sourceUrl}
                        </Link>
                      </td>
                      <td className="py-2.5">{names.get(j.projectId)}</td>
                      <td className="py-2.5">
                        <StatusBadge status={j.status} />
                      </td>
                      <td className="py-2.5">
                        <Progress value={Math.min(1, progress)} />
                      </td>
                      <td className="py-2.5 tabular-nums">{fmtNum(c.leads ?? 0)}</td>
                      <td className="py-2.5 text-[var(--muted)]">{fmtDate(j.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="المشاريع">
          {projects.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">أنشئ مشروعاً لتبدأ.</p>
          ) : (
            <ul className="divide-y divide-[var(--line)] text-sm">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2.5">
                  <Link href={`/leads?project=${p.id}`} className="font-medium hover:text-brand">
                    {p.name}
                  </Link>
                  <span className="text-[var(--muted)]">يحتفظ {p.retentionDays} يوماً</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="مشروع جديد">
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
