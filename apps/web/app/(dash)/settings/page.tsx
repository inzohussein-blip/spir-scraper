import { databaseRegion, databaseUrl } from "@scrapers/runtime";
import {
  checkProviders,
  connectTelegramCommands,
  createKey,
  revokeKey,
  sendTestNotification,
} from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Dot, Field, fmtDate, Input } from "@/components/ui";
import { twoFactorEnabled } from "@/lib/auth";
import { calendarToken } from "@/lib/backup";
import { appOrigin, integrationStatus } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";

const LABELS: Record<keyof ReturnType<typeof integrationStatus>, [string, string]> = {
  database: ["قاعدة البيانات", "DATABASE_URL"],
  worker: ["عامل Instaloader (مجاني)", "WORKER_URL"],
  apify: ["Apify (اكتشاف المتفاعلين)", "APIFY_TOKEN"],
  graph: ["Instagram Graph API (حساب تجاري/صانع محتوى)", "IG_GRAPH_TOKEN"],
  ai: ["التقييم بالذكاء الاصطناعي", "ANTHROPIC_API_KEY"],
  sheets: ["Google Sheets", "GOOGLE_SERVICE_ACCOUNT_JSON"],
  telegram: ["إشعارات تلكرام وكود الدخول، وقراءة قنوات تلكرام العامة", "TELEGRAM_BOT_TOKEN"],
  youtube: ["قراءة قنوات يوتيوب (مجاني، الواجهة الرسمية)", "YOUTUBE_API_KEY"],
  cron: ["المهام الخلفية", "CRON_SECRET"],
};

export default async function Settings() {
  const rt = await getRuntime();
  const [keys, twoFa, health, apify] = await Promise.all([
    rt.scrapers.listApiKeys(),
    twoFactorEnabled(),
    rt.scrapers.systemHealth(),
    rt.apifyUsage(),
  ]);
  const apifyPct = apify?.allowedUsd ? Math.round((apify.usedUsd / apify.allowedUsd) * 100) : 0;
  // Claude Haiku scoring: about 600 input and 80 output tokens per lead.
  const aiEstimateUsd = health.scoredThisMonth * (600 * 1 + 80 * 5) * 1e-6;
  // Storage limit of the database plan, for the health bar (Supabase free: 500MB, Neon free: per project).
  const dbLimitMb = Number(process.env.DB_SIZE_LIMIT_MB) || 500;
  const dbPct = Math.round((health.dbBytes / (dbLimitMb * 1024 * 1024)) * 100);
  const resting = Object.entries(health.providers).filter(([, s]) => s.until > Date.now());
  const status = integrationStatus();
  const origin = appOrigin();
  const db = databaseRegion(databaseUrl());
  const fnRegion = process.env.VERCEL_REGION ?? null;
  const regionsMatch = !db.vercelRegion || !fnRegion || db.vercelRegion === fnRegion;

  return (
    <>
      <Card title="ربط Claude عبر MCP" icon="plug">
        <div className="space-y-3 text-sm leading-7">
          <p>
            <strong>claude.ai:</strong> الإعدادات ← الموصّلات ← إضافة موصّل مخصّص، والصق الرابط. سيطلب
            منك الدخول بكلمة مرور اللوحة ثم الموافقة.
          </p>
          <code className="ltr block select-all rounded-[10px] bg-accent-soft p-3 font-mono text-xs text-accent">
            {origin}/api/mcp
          </code>
          <p>
            <strong>Claude Code:</strong> أنشئ مفتاحاً أدناه ثم:
          </p>
          <code className="ltr block select-all whitespace-pre-wrap rounded-[10px] bg-accent-soft p-3 font-mono text-xs text-accent">
            {`claude mcp add --transport http scrapers ${origin}/api/mcp --header "Authorization: Bearer sk_..."`}
          </code>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="الأمان" icon="shield">
          <ul className="space-y-3 text-sm">
            <li className="flex items-center justify-between gap-3">
              <span>التحقق بخطوتين (كود على تلكرام)</span>
              <Badge tone={twoFa ? "ok" : "warn"}>{twoFa ? "مفعّل" : "مطفأ"}</Badge>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>
                قفل الدخول بعد 5 محاولات خاطئة من نفس العنوان، أو 30 من الكل، لمدة 10 دقائق
              </span>
              <Badge tone="ok">مفعّل</Badge>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>تغيير كلمة المرور يُخرج كل الأجهزة</span>
              <Badge tone="ok">مفعّل</Badge>
            </li>
          </ul>
          <p className="mt-4 text-xs text-muted">
            لتفعيل الكود: أنشئ بوتاً من @BotFather، وأرسل له رسالة، ثم ضع TELEGRAM_BOT_TOKEN و
            TELEGRAM_CHAT_ID (آيديك من @userinfobot). للإطفاء عند الطوارئ: TWO_FACTOR=off.
          </p>
          {rt.telegram && (
            <div className="mt-4">
              <ActionForm action={sendTestNotification} submit="أرسل إشعار تجربة">
                <span />
              </ActionForm>
              <div className="mt-3">
                <ActionForm
                  action={connectTelegramCommands}
                  submit="فعّل أوامر البوت (/run /status /top)"
                >
                  <span />
                </ActionForm>
              </div>
            </div>
          )}
        </Card>

        <Card
          title="المصادر"
          icon="radar"
          description="يفحصها cron يومياً، وتصلك رسالة إذا توقف مصدر أو قارب الرصيد على النفاد."
        >
          <ActionForm action={checkProviders} submit="افحص المصادر الآن">
            <span />
          </ActionForm>
        </Card>
      </div>

      <Card
        title="الصرف هذا الشهر"
        description="رصيد Apify يُقرأ من حسابك مباشرة، وتكلفة التقييم بالذكاء الاصطناعي تقديرية."
      >
        <ul className="grid gap-3 text-sm sm:grid-cols-2">
          <li className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <span>Apify</span>
              <Badge tone={!apify ? "warn" : apifyPct > 85 ? "bad" : apifyPct > 60 ? "warn" : "ok"}>
                {apify
                  ? `$${apify.usedUsd.toFixed(2)} من $${apify.allowedUsd.toFixed(2)} · ${apifyPct}%`
                  : "غير متاح"}
              </Badge>
            </div>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>تقييم الذكاء الاصطناعي ({health.scoredThisMonth} عميلاً)</span>
            <Badge tone="info">≈ ${aiEstimateUsd.toFixed(2)}</Badge>
          </li>
        </ul>
      </Card>

      <Card
        title="النسخ الاحتياطي والتقويم"
        icon="download"
        description="نسخة من كل عملك (المشاريع والعملاء والملاحظات وقائمة عدم التواصل). تصلك نسخة أسبوعية على تلكرام تلقائياً إن كان مربوطاً."
      >
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="/api/backup"
              className="rounded-lg border border-line px-3 py-1.5 hover:bg-bg-2"
              download
            >
              تحميل نسخة الآن
            </a>
            <Badge tone={status.telegram ? "ok" : "warn"}>
              {status.telegram
                ? "النسخة الأسبوعية تصل على تلكرام"
                : "اربط تلكرام لتصلك نسخة أسبوعية"}
            </Badge>
          </div>
          <Field
            label="تقويم المتابعات"
            hint="في Google Calendar: الإعدادات ← إضافة تقويم ← من رابط، والصق هذا الرابط. لا تشاركه: من يملكه يرى أسماء من تتابعهم."
          >
            <Input
              readOnly
              className="ltr font-mono text-xs"
              value={`${origin}/api/calendar/${calendarToken()}.ics`}
              aria-label="رابط تقويم المتابعات"
            />
          </Field>
        </div>
      </Card>

      <Card
        title="صحة النظام"
        icon="activity"
        description="فكرة من لوحة بوت Spir: حالة الخادم والمصادر في مكان واحد."
      >
        <ul className="grid gap-3 text-sm sm:grid-cols-2">
          <li className="flex items-center justify-between gap-3">
            <span>آخر تشغيل للمهام الخلفية (cron)</span>
            <Badge tone={health.lastCron ? "ok" : "warn"}>
              {health.lastCron ? fmtDate(health.lastCron) : "لم يعمل بعد"}
            </Badge>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>المصادر المتوقفة مؤقتاً</span>
            <Badge tone={resting.length ? "warn" : "ok"}>
              {resting.length ? resting.map(([id]) => id).join("، ") : "لا شيء"}
            </Badge>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>حجم قاعدة البيانات (من {dbLimitMb}MB)</span>
            <Badge tone={dbPct > 80 ? "bad" : dbPct > 60 ? "warn" : "ok"}>
              {(health.dbBytes / 1024 / 1024).toFixed(1)}MB · {dbPct}%
            </Badge>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>منطقة الخادم · منطقة قاعدة البيانات</span>
            <Badge tone={regionsMatch ? "ok" : "warn"}>
              <span className="ltr">
                {fnRegion ?? "محلي"} · {db.region ?? "؟"}
              </span>
            </Badge>
          </li>
          {!regionsMatch && (
            <li className="text-[12.5px] text-warn sm:col-span-2">
              الخادم بعيد عن قاعدة البيانات، فكل صفحة أبطأ. ضع{" "}
              <span className="ltr font-medium">"regions": ["{db.vercelRegion}"]</span> في
              apps/web/vercel.json.
            </li>
          )}
          <li className="flex items-center justify-between gap-3">
            <span>العملاء · الملفات · المهام</span>
            <span className="tabular-nums text-fg-2">
              {health.leads} · {health.profiles} · {health.jobs}
            </span>
          </li>
        </ul>
      </Card>

      <Card title="مفاتيح API" icon="key">
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
            <ul className="divide-y divide-line text-sm">
              {keys.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span>
                    <strong>{k.name}</strong>{" "}
                    <span className="text-muted">[{k.scopes.join("، ")}]</span>
                  </span>
                  <span className="text-xs text-muted">آخر استخدام: {fmtDate(k.lastUsed)}</span>
                  <form action={revokeKey.bind(null, k.id)}>
                    <Button variant="danger" type="submit">
                      إلغاء
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">
            توثيق الـ API: <span className="ltr">{origin}/api/openapi.json</span>
          </p>
        </div>
      </Card>

      <Card title="التكاملات" icon="settings">
        <ul className="divide-y divide-line text-sm">
          {Object.entries(LABELS).map(([key, [label, env]]) => {
            const on = status[key as keyof typeof status];
            return (
              <li key={key} className="flex items-center justify-between py-2.5">
                <span className="flex items-center gap-2.5">
                  <Dot tone={on ? "ok" : "plain"} />
                  {label} <code className="ltr text-xs text-muted">{env}</code>
                </span>
                <span className={on ? "text-ok" : "text-muted"}>{on ? "مفعّل" : "غير مفعّل"}</span>
              </li>
            );
          })}
        </ul>
        {rt.sheetsEmail && (
          <p className="mt-3 text-xs text-muted">
            شارك الشيتات مع حساب الخدمة: <span className="ltr select-all">{rt.sheetsEmail}</span>
          </p>
        )}
      </Card>
    </>
  );
}
