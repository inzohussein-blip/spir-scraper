import { Badge, Card, fmtDate, Table } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

const ACTIONS: Record<string, [string, "ok" | "warn" | "bad" | "plain" | "info"]> = {
  "login.ok": ["دخول", "ok"],
  "login.failed": ["محاولة دخول خاطئة", "bad"],
  "login.code_sent": ["أُرسل كود تلكرام", "info"],
  logout: ["خروج", "plain"],
  "project.create": ["مشروع جديد", "info"],
  "job.start": ["بدء مهمة", "info"],
  "job.cancel": ["إلغاء مهمة", "warn"],
  "export.sheet": ["تصدير إلى Sheets", "info"],
  suppress: ["إيقاف شخص", "warn"],
  "key.create": ["إنشاء مفتاح API", "warn"],
  "key.revoke": ["إلغاء مفتاح API", "warn"],
  "oauth.approve": ["سماح لتطبيق MCP", "warn"],
};

export default async function Activity({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  const { action } = await searchParams;
  const list = await (await getRuntime()).scrapers.listAudit({
    limit: 300,
    ...(action ? { action } : {}),
  });
  return (
    <Card
      title="سجل النشاط"
      icon="activity"
      description="كل دخول، وكل محاولة خاطئة، وكل تغيير مهم، ومن أي عنوان."
      actions={
        <form className="flex gap-2" method="get">
          <select
            name="action"
            defaultValue={action ?? ""}
            className="rounded-[10px] border border-line bg-surface px-3 py-2 text-sm"
          >
            <option value="">كل الأنواع</option>
            {Object.entries(ACTIONS).map(([k, [label]]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-[10px] border border-line bg-surface px-3 py-2 text-sm hover:bg-surface-2"
          >
            تصفية
          </button>
        </form>
      }
    >
      {list.length === 0 ? (
        <p className="text-sm text-muted">لا يوجد نشاط مسجّل.</p>
      ) : (
        <Table head={["الوقت", "الحدث", "من", "التفاصيل", "العنوان"]}>
          {list.map((e) => {
            const [label, tone] = ACTIONS[e.action] ?? [e.action, "plain"];
            return (
              <tr key={e.id}>
                <td className="whitespace-nowrap text-muted">{fmtDate(e.at)}</td>
                <td>
                  <Badge tone={tone}>{label}</Badge>
                </td>
                <td className="text-fg-2">
                  {e.actor === "owner" ? "المالك" : e.actor === "anonymous" ? "مجهول" : e.actor}
                </td>
                <td className="ltr max-w-72 truncate font-mono text-xs text-muted">
                  {e.detail ? JSON.stringify(e.detail) : ""}
                </td>
                <td className="ltr font-mono text-xs text-muted">{e.ip ?? "—"}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </Card>
  );
}
