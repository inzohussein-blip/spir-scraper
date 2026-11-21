import { suppress } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Button, Card, fmtNum, Input, LinkButton, Notice, Select } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

type Search = {
  project?: string;
  job?: string;
  business?: string;
  has_email?: string;
  has_phone?: string;
  min_score?: string;
  page?: string;
};

const PAGE = 100;
const SOURCE: Record<string, string> = {
  business_button: "زر التواصل",
  bio: "البايو",
  link: "الرابط",
};

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const q = await searchParams;
  const rt = await getRuntime();
  const projects = await rt.scrapers.listProjects();
  const projectId = q.project ?? projects[0]?.id;
  if (!projectId) return <Notice tone="info">لا توجد مشاريع بعد.</Notice>;

  const page = Math.max(0, Number(q.page ?? 0));
  const minScore = q.min_score ? Number(q.min_score) : undefined;
  const rows = await rt.scrapers.listLeads({
    projectId,
    ...(q.job ? { jobId: q.job } : {}),
    ...(q.business ? { business: true } : {}),
    ...(q.has_email ? { hasEmail: true } : {}),
    ...(q.has_phone ? { hasPhone: true } : {}),
    ...(minScore !== undefined && !Number.isNaN(minScore) ? { minScore } : {}),
    limit: PAGE,
    offset: page * PAGE,
  });

  const params = new URLSearchParams(
    Object.entries({ ...q, project: projectId }).filter(
      (e): e is [string, string] => !!e[1] && e[0] !== "page",
    ),
  );
  const exportHref = (format: string) => `/api/export?${params}&format=${format}`;
  const pageHref = (p: number) => `/leads?${params}&page=${p}`;

  return (
    <>
      <Card title="تصفية">
        <form className="grid gap-3 sm:grid-cols-6" method="get">
          <Select name="project" defaultValue={projectId} className="sm:col-span-2">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          {q.job && <input type="hidden" name="job" value={q.job} />}
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
          <Input
            name="min_score"
            type="number"
            min={0}
            max={100}
            placeholder="أدنى درجة"
            defaultValue={q.min_score}
          />
          <Button type="submit" className="sm:col-span-6 sm:justify-self-start">
            تطبيق
          </Button>
        </form>
      </Card>

      <Card
        title={`العملاء${q.job ? " (مهمة واحدة)" : ""}`}
        actions={
          <div className="flex gap-2">
            <LinkButton href={exportHref("xlsx")}>Excel</LinkButton>
            <LinkButton href={exportHref("csv")}>CSV</LinkButton>
          </div>
        }
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted">لا توجد نتائج.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 text-start font-medium">الحساب</th>
                  <th className="py-2 text-start font-medium">المتابعون</th>
                  <th className="py-2 text-start font-medium">الإيميل</th>
                  <th className="py-2 text-start font-medium">الهاتف</th>
                  <th className="py-2 text-start font-medium">المصدر</th>
                  <th className="py-2 text-start font-medium">الدرجة</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.username} className="border-b border-line align-top last:border-0">
                    <td className="py-2.5">
                      <a
                        href={`https://www.instagram.com/${r.username}/`}
                        target="_blank"
                        rel="noreferrer"
                        className="ltr font-medium text-accent hover:underline"
                      >
                        @{r.username}
                      </a>
                      <div className="text-xs text-muted">
                        {[r.fullName, r.category, r.isBusiness ? "تجاري" : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </td>
                    <td className="py-2.5 tabular-nums">{fmtNum(r.followers)}</td>
                    <td className="ltr py-2.5">{r.email ?? "—"}</td>
                    <td className="py-2.5">
                      <span className="ltr">{r.phone ?? "—"}</span>
                      {r.phone && !r.phoneConfirmed && (
                        <span className="ms-1 text-xs text-amber-600">غير مؤكد</span>
                      )}
                      {r.phoneCountry && (
                        <span className="ms-1 text-xs text-muted">{r.phoneCountry}</span>
                      )}
                    </td>
                    <td className="py-2.5 text-xs">
                      {r.contactSource ? SOURCE[r.contactSource] : "—"}
                    </td>
                    <td className="py-2.5" title={r.aiReason ?? undefined}>
                      {r.aiScore ?? "—"}
                      {r.aiTags && <div className="text-xs text-muted">{r.aiTags.join("، ")}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex gap-2">
          {page > 0 && <LinkButton href={pageHref(page - 1)}>السابق</LinkButton>}
          {rows.length === PAGE && <LinkButton href={pageHref(page + 1)}>التالي</LinkButton>}
        </div>
      </Card>

      <Card title="إيقاف شخص وحذف بياناته">
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
