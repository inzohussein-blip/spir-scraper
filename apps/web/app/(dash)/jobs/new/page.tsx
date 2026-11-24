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
  const rt = await getRuntime();
  const projects = await rt.scrapers.listProjects();
  const status = integrationStatus();
  // What this month's remaining Apify credit can still collect and read.
  const usage = status.apify ? await rt.apifyUsage().catch(() => null) : null;
  const engineOnline = await rt.scrapers.engineOnline();
  const remaining = usage ? Math.max(0, usage.allowedUsd - usage.usedUsd) : null;
  const perAccount =
    rt.scrapers.estimateCost(
      { type: "followers", username: "x", url: "https://www.instagram.com/x/" },
      1000,
    ) / 1000;
  const capacity = remaining !== null && perAccount > 0 ? Math.floor(remaining / perAccount) : null;

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
      {remaining !== null && (
        <Notice tone={capacity !== null && capacity < 200 ? "warn" : "info"}>
          رصيد Apify المتبقي هذا الشهر ${remaining.toFixed(2)}
          {capacity !== null
            ? `: يكفي تقريباً ${capacity.toLocaleString("en")} حساب (جمع وقراءة)`
            : ""}
          . الحسابات المقروءة خلال 30 يوماً لا تُدفع مرة أخرى، والقوائم الملصقة وملفات CSV مجانية مع
          العامل المنزلي.
        </Notice>
      )}
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
            label="رابط حساب منافس أو منشور أو هاشتاق أو مكان، أو كلمات للبحث"
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
              <option value="search">بحث بكلمات (مثل: مدرب تداول)</option>
              <option value="location">موقع (رابط صفحة مكان في إنستقرام)</option>
              <option value="similar">حسابات مشابهة لحساب</option>
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

        <Field
          label="طريقة القراءة"
          hint={
            engineOnline
              ? "جهاز المحرك متصل الآن: «تلقائي» يقرأ عبره مجاناً."
              : "لا يوجد جهاز محرك متصل: «تلقائي» يقرأ عبر Apify."
          }
        >
          <Select name="read_via" defaultValue="auto">
            <option value="auto">تلقائي: المحرك إن كان جهاز متصلاً، وإلا Apify</option>
            <option value="engine">محرك Spir: مجاني وأبطأ (حساب كل دقيقة تقريباً)</option>
            <option value="providers">Apify: أسرع ويُخصم من الرصيد</option>
          </Select>
        </Field>
        <Field label="الحد الأقصى للحسابات">
          <Input name="limit" type="number" min={1} max={10000} defaultValue={100} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="accept_cost" />
          أوافق على التكلفة التقديرية إن وُجدت (Apify)
        </label>
      </ActionForm>
    </Card>
  );
}
