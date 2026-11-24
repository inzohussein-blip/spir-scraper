import { USAGE_LABELS, type UsageCategory } from "@scrapers/core";
import { saveUsageLimits } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, fmtNum, Input, Notice } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";
import { level, type Meter, pct, usageMeters } from "@/lib/usage";

export const metadata = { title: "الاستهلاك" };

const TONE = { ok: "ok", warn: "warn", bad: "bad" } as const;
const BAR = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" } as const;

/** What to do when a kind of request costs the most. */
const TIPS: Partial<Record<UsageCategory, string>> = {
  dashboard: "أغلق صفحات المهام المفتوحة في الخلفية، فكل تحديث للصفحة طلب.",
  engine: "زد «دقائق الدفعة» في صفحة المحرك (60 أو 90)، أو أطل ساعات الراحة.",
  api: "أكثرها من علامة الإضافة على إنستقرام: حدّث الإضافة (تبحث محلياً وتحدّث القائمة مرة يومياً).",
  queue: "مهام كثيرة صغيرة: اجمع الحسابات في مهمة واحدة أكبر.",
  mcp: "Claude يسأل عن حالة المهمة كثيراً أثناء انتظارها.",
  telegram: "رسائل البوت والأزرار: لا تحتاج تغييراً عادةً.",
};

function fmtUsed(m: Meter, n: number) {
  if (m.unit === "$") return `$${n.toFixed(2)}`;
  return `${n < 10 ? n.toFixed(1) : fmtNum(Math.round(n))} ${m.unit}`;
}

export default async function UsagePage() {
  const rt = await getRuntime();
  const { report, limits, meters, neonConnected } = await usageMeters(rt);
  const maxDay = Math.max(1, ...report.days.map((d) => d.awakeMinutes));
  const top = report.byCategory[0];

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h1 className="text-lg font-bold">الاستهلاك</h1>
        <p className="text-sm text-muted">
          ما استهلكته المنصة هذا الشهر من الخطط المجانية، وتوقع نهاية الشهر بنفس المعدل. يصلك تنبيه
          عند 70% و90%، أو إن كان التوقع يتجاوز الحد. الأرقام المقدّرة تقريبية؛ عدّل الحدود حسب صفحة
          خطتك.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {meters.map((m) => {
          const lv = level(m);
          return (
            <div key={m.key} className="card space-y-2 p-4">
              <div className="flex items-center justify-between text-[12.5px] text-muted">
                {m.label}
                <Badge tone={TONE[lv]} dot={false}>
                  {Math.round(pct(m))}%
                </Badge>
              </div>
              <div className="text-xl font-bold tabular-nums">
                {fmtUsed(m, m.used)}{" "}
                <span className="text-sm font-normal text-muted">/ {fmtUsed(m, m.limit)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-bg-2">
                <div
                  className={`h-full ${BAR[lv]}`}
                  style={{ width: `${Math.min(100, pct(m))}%` }}
                />
              </div>
              <div className="text-xs text-muted">
                {m.forecast !== null ? `توقع الشهر: ${fmtUsed(m, m.forecast)}` : "يتغير ببطء"}
                {m.exact ? " · من المزوّد" : " · تقدير"}
              </div>
            </div>
          );
        })}
      </div>

      {!neonConnected && (
        <Notice tone="info">
          ساعات تشغيل القاعدة تقدير من أوقات الطلبات. للرقم الدقيق من Neon أضف في Vercel{" "}
          <span className="ltr font-mono">NEON_API_KEY</span> (Neon ← Account settings ← API keys) و{" "}
          <span className="ltr font-mono">NEON_PROJECT_ID</span> (Neon ← Project settings).
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="من يوقظ المنصة"
          icon="activity"
          description="الطلبات هذا الشهر حسب مصدرها. الأكثر أولاً."
        >
          {report.byCategory.length === 0 ? (
            <p className="text-sm text-muted">لا شيء بعد هذا الشهر.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {report.byCategory.map((c) => {
                const share = report.requests ? (c.requests / report.requests) * 100 : 0;
                return (
                  <li key={c.category}>
                    <div className="flex justify-between">
                      <span>{USAGE_LABELS[c.category] ?? c.category}</span>
                      <span className="tabular-nums text-muted">
                        {fmtNum(c.requests)} · {Math.round(share)}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-2">
                      <div className="h-full bg-accent" style={{ width: `${share}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {top && TIPS[top.category] && (
            <p className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-sm">
              💡 {TIPS[top.category]}
            </p>
          )}
        </Card>

        <Card
          title="تشغيل القاعدة يومياً"
          icon="chart"
          description="دقائق تقديرية بقيت فيها قاعدة البيانات مستيقظة كل يوم (تنام بعد دقائق بلا طلبات)."
        >
          {report.days.length === 0 ? (
            <p className="text-sm text-muted">لا شيء بعد هذا الشهر.</p>
          ) : (
            <div className="flex h-36 items-end gap-1">
              {report.days.map((d) => (
                <div
                  key={d.day}
                  className="flex-1 rounded-t bg-accent/70"
                  style={{ height: `${Math.max(2, (d.awakeMinutes / maxDay) * 100)}%` }}
                  title={`${d.day}: ${d.awakeMinutes} دقيقة · ${d.requests} طلب`}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="أكبر الجداول"
          icon="folder"
          description="ما يشغل مساحة القاعدة. القديم يُنظَّف يومياً."
        >
          <ul className="divide-y divide-line text-sm">
            {report.tables.map((t) => (
              <li key={t.name} className="flex justify-between py-1.5">
                <span className="ltr font-mono text-xs">{t.name}</span>
                <span className="tabular-nums text-muted">
                  {(t.bytes / 1_048_576).toFixed(1)} MB
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="حدود خطتك" icon="settings" description="عدّلها إن كانت خطتك مختلفة أو تغيّرت.">
          <ActionForm action={saveUsageLimits} submit="حفظ" className="grid grid-cols-2 gap-3">
            <Field label="ساعات تشغيل القاعدة شهرياً">
              <Input name="db_hours" type="number" min={1} defaultValue={limits.dbHours} />
            </Field>
            <Field label="حجم القاعدة (MB)">
              <Input name="db_storage_mb" type="number" min={1} defaultValue={limits.dbStorageMb} />
            </Field>
            <Field label="طلبات المنصة شهرياً">
              <Input name="requests" type="number" min={1} defaultValue={limits.requests} />
            </Field>
            <Field label="رصيد Apify ($)" hint="يُقرأ من Apify إن كان مربوطاً">
              <Input
                name="apify_usd"
                type="number"
                min={1}
                step="0.5"
                defaultValue={limits.apifyUsd}
              />
            </Field>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}
