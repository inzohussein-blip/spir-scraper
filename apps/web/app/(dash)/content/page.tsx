import { makeContentPlan } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, fmtDate, Notice, Select } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "المحتوى" };

const GOAL_TONE: Record<string, "ok" | "warn" | "plain"> = { تحويل: "ok", ثقة: "warn" };

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const q = await searchParams;
  const rt = await getRuntime();
  const projects = await rt.scrapers.listProjects();
  const projectId = q.project ?? projects[0]?.id;
  const plan = projectId ? await rt.scrapers.savedContentPlan(projectId) : null;

  return (
    <div className="space-y-4">
      <Card
        title="خطة المحتوى"
        icon="sparkles"
        description="أسبوع من المحتوى وثلاثة سكربتات ريلز، مبنية على منشوراتك التي جلبت عملاء ومالاً، والمواضيع الصاعدة، والمنافسين الأسرع نمواً، وشرائح جمهورك."
      >
        {!projectId ? (
          <Notice tone="info">لا توجد مشاريع بعد.</Notice>
        ) : (
          <ActionForm
            action={makeContentPlan}
            submit={plan ? "خطة جديدة" : "اصنع الخطة"}
            className="flex flex-wrap items-end gap-2"
          >
            <Field label="المشروع">
              <Select name="project" defaultValue={projectId}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </ActionForm>
        )}
        {plan && (
          <p className="mt-3 text-xs text-muted">
            {plan.byAi ? "كتبها الذكاء الاصطناعي" : "من القالب"} · {fmtDate(plan.createdAt)}
          </p>
        )}
      </Card>

      {plan && (
        <>
          <Card title="الأسبوع" icon="chart">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-[12.5px] text-muted">
                    {["اليوم", "النوع", "الموضوع", "البداية", "الشريحة", "الهدف"].map((h) => (
                      <th key={h} className="px-2 py-2 text-start font-medium first:ps-0">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {plan.days.map((d) => (
                    <tr key={d.day} className="border-b border-line align-top last:border-0">
                      <td className="py-2.5 pe-2 font-medium">{d.day}</td>
                      <td className="px-2">{d.format}</td>
                      <td className="px-2">{d.topic}</td>
                      <td className="px-2">{d.hook}</td>
                      <td className="px-2 text-muted">{d.persona ?? "—"}</td>
                      <td className="px-2">
                        <Badge tone={GOAL_TONE[d.goal] ?? "plain"} dot={false}>
                          {d.goal}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            {plan.reels.map((r) => (
              <Card key={r.title} title={r.title} icon="activity">
                <div className="space-y-2 text-sm">
                  <p className="font-medium">«{r.hook}»</p>
                  <p className="whitespace-pre-wrap text-muted">{r.script}</p>
                  <p>
                    <span className="text-muted">الدعوة: </span>
                    {r.cta}
                  </p>
                  {r.issues.length > 0 && (
                    <Notice tone="warn">راجع قبل النشر: {r.issues.join(" ")}</Notice>
                  )}
                </div>
              </Card>
            ))}
          </div>

          {plan.notes.length > 0 && (
            <Card title="لماذا هذه الخطة" icon="check">
              <ul className="list-inside list-disc space-y-1 text-sm">
                {plan.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
