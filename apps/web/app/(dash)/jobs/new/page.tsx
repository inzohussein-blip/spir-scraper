import Link from "next/link";
import { startJob } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { integrationStatus } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";

export default async function NewJob({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  const projects = await (await getRuntime()).scrapers.listProjects();
  const status = integrationStatus();

  if (projects.length === 0) {
    return (
      <Notice tone="info">
        أنشئ مشروعاً أولاً من{" "}
        <Link href="/" className="underline">
          الصفحة الرئيسية
        </Link>
        .
      </Notice>
    );
  }

  return (
    <Card title="مهمة جديدة">
      <ActionForm action={startJob} submit="ابدأ">
        <Field label="المشروع">
          <Select name="project" defaultValue={project ?? projects[0]?.id} required>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset className="space-y-4 rounded-lg border border-line p-4">
          <legend className="px-1 text-sm font-medium">المصدر: اختر طريقة واحدة</legend>
          <Field
            label="رابط حساب منافس أو منشور أو هاشتاق"
            hint={
              status.apify
                ? "يُكتشف المتفاعلون عبر Apify."
                : "يحتاج APIFY_TOKEN في الإعدادات. بدونه استخدم القائمة أو ملف CSV."
            }
          >
            <Input
              name="source"
              className="ltr"
              placeholder="https://instagram.com/competitor أو #forex"
            />
          </Field>
          <Field label="نوع الرابط">
            <Select name="type" defaultValue="">
              <option value="">تلقائي</option>
              <option value="profile">حساب: المعلّقون على منشوراته</option>
              <option value="followers">حساب: قائمة متابعيه</option>
              <option value="post">منشور</option>
              <option value="hashtag">هاشتاق</option>
            </Select>
          </Field>
          <div className="text-center text-xs text-muted">أو</div>
          <Field label="ملف CSV بالمعرّفات" hint="عمود username أو روابط حسابات. مجاني دائماً.">
            <input name="csv" type="file" accept=".csv,text/csv" className="text-sm" />
          </Field>
          <Field label="أو الصق المعرّفات (سطر لكل معرّف)">
            <Textarea name="usernames" className="ltr" placeholder={"@account1\n@account2"} />
          </Field>
        </fieldset>

        <Field label="الحد الأقصى للحسابات">
          <Input name="limit" type="number" min={1} max={1000} defaultValue={100} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="accept_cost" />
          أوافق على التكلفة التقديرية إن وُجدت (Apify)
        </label>
      </ActionForm>
    </Card>
  );
}
