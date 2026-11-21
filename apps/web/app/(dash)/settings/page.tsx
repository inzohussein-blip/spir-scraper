import { createKey, revokeKey } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, fmtDate, Input } from "@/components/ui";
import { appOrigin, integrationStatus } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";

const LABELS: Record<keyof ReturnType<typeof integrationStatus>, [string, string]> = {
  database: ["قاعدة البيانات", "DATABASE_URL"],
  worker: ["عامل Instaloader (مجاني)", "WORKER_URL"],
  apify: ["Apify (اكتشاف المتفاعلين)", "APIFY_TOKEN"],
  graph: ["Instagram Graph API (حساب تجاري/صانع محتوى)", "IG_GRAPH_TOKEN"],
  ai: ["التقييم بالذكاء الاصطناعي", "ANTHROPIC_API_KEY"],
  sheets: ["Google Sheets", "GOOGLE_SERVICE_ACCOUNT_JSON"],
  cron: ["المهام الخلفية", "CRON_SECRET"],
};

export default async function Settings() {
  const rt = await getRuntime();
  const keys = await rt.scrapers.listApiKeys();
  const status = integrationStatus();
  const origin = appOrigin();

  return (
    <>
      <Card title="ربط Claude عبر MCP">
        <div className="space-y-3 text-sm leading-7">
          <p>
            <strong>claude.ai:</strong> الإعدادات ← الموصّلات ← إضافة موصّل مخصّص، والصق الرابط. سيطلب
            منك الدخول بكلمة مرور اللوحة ثم الموافقة.
          </p>
          <code className="ltr block select-all rounded-lg bg-brand-soft p-3 font-mono text-xs text-brand">
            {origin}/api/mcp
          </code>
          <p>
            <strong>Claude Code:</strong> أنشئ مفتاحاً أدناه ثم:
          </p>
          <code className="ltr block select-all whitespace-pre-wrap rounded-lg bg-brand-soft p-3 font-mono text-xs text-brand">
            {`claude mcp add --transport http scrapers ${origin}/api/mcp --header "Authorization: Bearer sk_..."`}
          </code>
        </div>
      </Card>

      <Card title="مفاتيح API">
        <div className="space-y-5">
          <ActionForm
            action={createKey}
            submit="إنشاء مفتاح"
            className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
          >
            <Field label="الاسم">
              <Input name="name" placeholder="n8n" maxLength={50} />
            </Field>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" name="write" defaultChecked /> كتابة
            </label>
          </ActionForm>
          {keys.length > 0 && (
            <ul className="divide-y divide-[var(--line)] text-sm">
              {keys.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span>
                    <strong>{k.name}</strong>{" "}
                    <span className="text-[var(--muted)]">[{k.scopes.join("، ")}]</span>
                  </span>
                  <span className="text-xs text-[var(--muted)]">
                    آخر استخدام: {fmtDate(k.lastUsed)}
                  </span>
                  <form action={revokeKey.bind(null, k.id)}>
                    <Button variant="danger" type="submit">
                      إلغاء
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-[var(--muted)]">
            توثيق الـ API: <span className="ltr">{origin}/api/openapi.json</span>
          </p>
        </div>
      </Card>

      <Card title="التكاملات">
        <ul className="divide-y divide-[var(--line)] text-sm">
          {Object.entries(LABELS).map(([key, [label, env]]) => {
            const on = status[key as keyof typeof status];
            return (
              <li key={key} className="flex items-center justify-between py-2.5">
                <span>
                  {label} <code className="ltr text-xs text-[var(--muted)]">{env}</code>
                </span>
                <span className={on ? "text-emerald-600" : "text-[var(--muted)]"}>
                  {on ? "مفعّل" : "غير مفعّل"}
                </span>
              </li>
            );
          })}
        </ul>
        {rt.sheetsEmail && (
          <p className="mt-3 text-xs text-[var(--muted)]">
            شارك الشيتات مع حساب الخدمة: <span className="ltr select-all">{rt.sheetsEmail}</span>
          </p>
        )}
      </Card>
    </>
  );
}
