import { STORE_CATEGORIES, storeTool } from "@scrapers/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { runStoreTool, startJob } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import {
  Badge,
  Card,
  Field,
  fmtDate,
  Input,
  Notice,
  Select,
  StatusBadge,
  Table,
  Textarea,
} from "@/components/ui";
import { getRuntime } from "@/lib/runtime";
import { missingNeeds, priceLabel, TOOL_ICON } from "@/lib/store";

/** An Apify run can take a few minutes; the form waits for it. */
export const maxDuration = 300;

const COUNTRIES = [
  ["ALL", "كل الدول"],
  ["SA", "السعودية"],
  ["AE", "الإمارات"],
  ["KW", "الكويت"],
  ["QA", "قطر"],
  ["BH", "البحرين"],
  ["OM", "عُمان"],
  ["IQ", "العراق"],
  ["JO", "الأردن"],
  ["EG", "مصر"],
] as const;

/** One store tool: what it does, its price, its input form and its last runs. */
export default async function StoreTool({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tool = storeTool(id);
  if (!tool) notFound();
  const rt = await getRuntime();
  const [engineOnline, projects] = await Promise.all([
    rt.scrapers.engineOnline(),
    rt.scrapers.listProjects(),
  ]);
  const missing = missingNeeds(tool, engineOnline);
  const run = tool.run;
  const toolRuns =
    run.kind === "tool" ? await rt.scrapers.listToolRuns({ tool: tool.id, limit: 10 }) : [];
  const jobs =
    run.kind === "job"
      ? (await rt.scrapers.listJobs({ limit: 100 }))
          .filter((j) => j.sourceType === run.sourceType)
          .slice(0, 10)
      : [];

  const projectField = (optional: boolean) =>
    projects.length > 0 && (
      <Field label={optional ? "المشروع (اختياري)" : "المشروع"}>
        <Select name="project" defaultValue={optional ? "" : projects[0]?.id} required={!optional}>
          {optional && <option value="">بلا مشروع</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
    );

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/store" className="text-sm text-muted hover:underline">
          المتجر
        </Link>
        <span className="text-muted">/</span>
        <span className="text-sm">{STORE_CATEGORIES[tool.category]}</span>
      </div>
      <div className="card flex flex-wrap items-start gap-4 p-5">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
          <Icon name={TOOL_ICON[tool.category]} className="size-6" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <h2 className="text-lg font-bold">{tool.name}</h2>
          <p className="text-sm text-fg-2">{tool.summary}</p>
          <p className="text-sm">
            <span className="text-muted">النتيجة: </span>
            {tool.output}
          </p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge tone={tool.pricing.kind === "apify" ? "warn" : "ok"}>{priceLabel(tool)}</Badge>
            <Badge tone="plain">{STORE_CATEGORIES[tool.category]}</Badge>
          </div>
        </div>
      </div>

      {missing.length > 0 && (
        <Notice tone="warn">
          تحتاج هذه الأداة: {missing.join("، ")}. أضفه في Vercel (Settings ← Environment Variables)
          ثم أعد النشر. الخطوات في صفحة{" "}
          <Link href="/settings" className="underline">
            الإعدادات
          </Link>
          .
        </Notice>
      )}

      {run.kind === "page" && (
        <Card title="التشغيل" icon="play">
          <p className="mb-3 text-sm text-fg-2">لهذه الأداة نافذة خاصة فيها كل إعداداتها.</p>
          <Link
            href={run.href}
            className="inline-flex items-center gap-2 rounded-[10px] border border-accent bg-accent px-4 py-2 text-sm font-medium text-accent-text"
          >
            افتح الأداة
          </Link>
        </Card>
      )}

      {run.kind === "job" &&
        (projects.length === 0 ? (
          <Notice tone="info">
            أنشئ مشروعاً أولاً من{" "}
            <Link href="/" className="underline">
              الصفحة الرئيسية
            </Link>
            ، فالعملاء يُحفظون فيه.
          </Notice>
        ) : (
          <Card title="الإدخال" icon="play" description="العملاء يُحفظون في المشروع الذي تختاره.">
            <ActionForm action={startJob} submit="ابدأ التشغيل">
              {projectField(false)}
              {run.sourceType === "upload" ? (
                <>
                  <Field label="المعرّفات (سطر لكل معرّف)">
                    <Textarea
                      name="usernames"
                      className="ltr"
                      placeholder={"@account1\n@account2"}
                    />
                  </Field>
                  <Field label="أو ملف CSV" hint="عمود username أو روابط حسابات.">
                    <input name="csv" type="file" accept=".csv,text/csv" className="text-sm" />
                  </Field>
                </>
              ) : (
                <>
                  <input type="hidden" name="type" value={run.sourceType} />
                  <Field
                    label={
                      run.sourceType === "search"
                        ? "كلمات البحث"
                        : run.sourceType === "hashtag"
                          ? "الهاشتاق"
                          : run.sourceType === "post"
                            ? "رابط المنشور"
                            : run.sourceType === "location"
                              ? "رابط صفحة المكان"
                              : "الحساب (رابط أو @معرّف)"
                    }
                  >
                    <Input
                      name="source"
                      required
                      className="ltr"
                      placeholder={
                        run.sourceType === "search"
                          ? "مدرب تداول"
                          : run.sourceType === "hashtag"
                            ? "#forex"
                            : "https://instagram.com/competitor"
                      }
                    />
                  </Field>
                </>
              )}
              <Field
                label="طريقة القراءة"
                hint={
                  engineOnline
                    ? "جهاز المحرك متصل: «تلقائي» يقرأ مجاناً."
                    : "لا جهاز محرك متصل الآن."
                }
              >
                <Select name="read_via" defaultValue="auto">
                  <option value="auto">تلقائي: المحرك إن كان متصلاً، وإلا Apify</option>
                  <option value="engine">محرك Spir: مجاني وأبطأ</option>
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
        ))}

      {run.kind === "tool" && (
        <Card
          title="الإدخال"
          icon="play"
          description="تنتظر الصفحة النتائج (حتى بضع دقائق مع Apify)، ثم تفتح مجموعة النتائج."
        >
          <ActionForm action={runStoreTool} submit="ابدأ التشغيل">
            <input type="hidden" name="tool" value={tool.id} />
            <Field
              label={tool.id === "fb-ads" ? "كلمات البحث أو رابط صفحة فيسبوك" : "رابط الفيديو"}
            >
              <Input name="query" required className="ltr" placeholder={tool.example} />
            </Field>
            {tool.id === "fb-ads" && (
              <Field label="الدولة">
                <Select name="country" defaultValue="SA">
                  {COUNTRIES.map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field
              label="الحد الأقصى للنتائج"
              hint={
                tool.pricing.per1k
                  ? `100 نتيجة ≈ $${((tool.pricing.per1k * 100) / 1000).toFixed(3)} من رصيد Apify.`
                  : "مجاني."
              }
            >
              <Input name="limit" type="number" min={1} max={1000} defaultValue={100} />
            </Field>
            {projectField(true)}
          </ActionForm>
        </Card>
      )}

      {(toolRuns.length > 0 || jobs.length > 0) && (
        <Card title="آخر التشغيلات" icon="clock" flush>
          <div className="px-[18px] py-2">
            <Table head={["البداية", "الإدخال", "الحالة", "النتائج", ""]}>
              {toolRuns.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{fmtDate(r.startedAt)}</td>
                  <td className="ltr max-w-64 truncate">{String(r.input.query ?? "")}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="tabular-nums">
                    {r.items}
                    {r.flagged > 0 && <span className="text-ok"> · {r.flagged} مهم</span>}
                  </td>
                  <td>
                    <Link href={`/runs/${r.id}`} className="text-accent hover:underline">
                      النتائج
                    </Link>
                  </td>
                </tr>
              ))}
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="whitespace-nowrap">{fmtDate(j.createdAt)}</td>
                  <td className="ltr max-w-64 truncate">{j.sourceUrl}</td>
                  <td>
                    <StatusBadge status={j.status} />
                  </td>
                  <td className="tabular-nums">{j.counts.enriched ?? 0}</td>
                  <td>
                    <Link href={`/jobs/${j.id}`} className="text-accent hover:underline">
                      التفاصيل
                    </Link>
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        </Card>
      )}
    </>
  );
}
