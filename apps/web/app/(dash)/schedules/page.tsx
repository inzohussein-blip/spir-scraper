import Link from "next/link";
import { addMonitor, removeMonitor, toggleMonitor } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, fmtDate, Input, Select, Table } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

/**
 * «الجدولة»: tools that run again by themselves (competitor monitors). They
 * run with the daily job and collect only accounts not yet in the project.
 */
export default async function Schedules() {
  const rt = await getRuntime();
  const [monitors, projects] = await Promise.all([
    rt.scrapers.listMonitors(),
    rt.scrapers.listProjects(),
  ]);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  return (
    <>
      <Card
        title="التشغيلات المجدولة"
        icon="clock"
        description="تعمل مع المهمة اليومية، وتجمع الحسابات الجديدة فقط. أوقفها حين لا تحتاجها لتوفير الرصيد."
        flush
      >
        <div className="px-[18px] py-2">
          {monitors.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">لا تشغيلات مجدولة بعد.</p>
          ) : (
            <Table head={["المصدر", "المشروع", "التكرار", "آخر تشغيل", "الحالة", ""]}>
              {monitors.map((m) => (
                <tr key={m.id}>
                  <td className="ltr max-w-72 truncate">{m.sourceUrl}</td>
                  <td>{projectName.get(m.projectId) ?? "-"}</td>
                  <td className="whitespace-nowrap">كل {m.everyDays} يوم</td>
                  <td className="whitespace-nowrap">{fmtDate(m.lastRunAt)}</td>
                  <td>
                    <Badge tone={m.enabled ? "ok" : "plain"}>{m.enabled ? "يعمل" : "متوقف"}</Badge>
                  </td>
                  <td>
                    <div className="flex gap-1.5">
                      <form action={toggleMonitor.bind(null, m.id, !m.enabled)}>
                        <Button variant="default" type="submit" className="px-2.5 py-1 text-xs">
                          {m.enabled ? "إيقاف" : "تشغيل"}
                        </Button>
                      </form>
                      <form action={removeMonitor.bind(null, m.id)}>
                        <Button variant="danger" type="submit" className="px-2.5 py-1 text-xs">
                          حذف
                        </Button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </Card>

      {projects.length > 0 ? (
        <Card title="جدولة جديدة" icon="plus">
          <ActionForm action={addMonitor} submit="أضف الجدولة">
            <Field label="المشروع">
              <Select name="project" defaultValue={projects[0]?.id} required>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="حساب منافس أو منشور أو هاشتاق">
              <Input
                name="source"
                required
                className="ltr"
                placeholder="https://instagram.com/competitor"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="كل كم يوم">
                <Input name="every" type="number" min={1} max={90} defaultValue={7} />
              </Field>
              <Field label="الحد الأقصى">
                <Input name="limit" type="number" min={1} max={1000} defaultValue={100} />
              </Field>
            </div>
          </ActionForm>
        </Card>
      ) : (
        <p className="text-sm text-muted">
          أنشئ مشروعاً من{" "}
          <Link href="/" className="underline">
            الرئيسية
          </Link>{" "}
          أولاً.
        </p>
      )}
    </>
  );
}
