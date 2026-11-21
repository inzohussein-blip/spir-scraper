# النشر على Vercel

المستودع جاهز للنشر: لوحة التحكم، والـ REST API، وخادم MCP لـ Claude، و OAuth كلها في تطبيق واحد هو `apps/web`. قاعدة البيانات على Supabase.

## ما يعمل على Vercel وما لا يعمل

| الجزء | على Vercel | ملاحظة |
|---|---|---|
| اللوحة + API + MCP + OAuth | ✅ | تطبيق Next.js واحد |
| معالجة المهام | ✅ | بدون عامل دائم: تُعالَج بعد كل طلب وتسلّم نفسها لاستدعاء جديد حتى تنتهي، ومهمة cron يومية كشبكة أمان |
| Apify (الاكتشاف والجلب) | ✅ | الطريقة الموصى بها على Vercel |
| عامل Instaloader (Python) | ❌ | خوادم Vercel عناوين مراكز بيانات يحجبها إنستقرام بسرعة. شغّله على جهازك واربطه بـ `WORKER_URL` عبر نفق (مثل Cloudflare Tunnel)، أو اكتفِ بـ Apify |

> **تنبيه الخطة المجانية:** خطة Hobby في Vercel مخصصة للاستخدام الشخصي غير التجاري حسب شروطهم. للاستخدام التجاري تحتاج خطة Pro. راجع شروط Vercel الحالية.

## الخطوة 1 — Supabase (مجاني)

1. أنشئ مشروعاً على supabase.com.
2. من **Connect** خذ رابطين:
   - **Transaction pooler** (المنفذ 6543) ← `DATABASE_URL`
   - **Session pooler** (المنفذ 5432 على عنوان الـ pooler) ← `DIRECT_DATABASE_URL`

   لا تستخدم الرابط المباشر `db.xxx.supabase.co`، فهو IPv6 فقط و Vercel لا يدعمه. الطابور (pg-boss) يحتاج Session pooler.
3. طبّق الجداول مرة واحدة من جهازك:
   ```bash
   DIRECT_DATABASE_URL="postgres://...:5432/postgres" pnpm db:migrate
   ```

## الخطوة 2 — ربط Vercel

1. في vercel.com: **Add New → Project** واختر المستودع `spir-scraper` من GitHub.
2. **Root Directory:** `apps/web`. أوامر التثبيت والبناء مضبوطة في `apps/web/vercel.json` فلا تغيّرها.
3. أضف متغيرات البيئة (Settings → Environment Variables):

| المتغير | إلزامي | القيمة |
|---|---|---|
| `DATABASE_URL` | ✅ | Transaction pooler من Supabase |
| `DIRECT_DATABASE_URL` | ✅ | Session pooler من Supabase |
| `SUPPRESSION_PEPPER` | ✅ | `openssl rand -hex 32` (لا تغيّره بعد البدء) |
| `AUTH_SECRET` | ✅ | `openssl rand -hex 32` (تغييره يُلغي كل الجلسات والرموز) |
| `DASHBOARD_PASSWORD` | ✅ | كلمة مرور اللوحة، 12 حرفاً على الأقل |
| `CRON_SECRET` | ✅ | `openssl rand -hex 32`، و Vercel يرسله تلقائياً مع مهام cron |
| `OWNER_EMAIL` | مستحسن | إيميلك، وتُشارَك معه الشيتات الجديدة |
| `APP_URL` | مستحسن | رابط النشر النهائي، مثل `https://scrapers.vercel.app` |
| `APIFY_TOKEN` | للاكتشاف | من حسابك في Apify |
| `APIFY_MONTHLY_CAP_USD` | | `0` = الرصيد المجاني فقط |
| `ANTHROPIC_API_KEY` | اختياري | للتقييم من اللوحة. عبر MCP يقيّم Claude بنفسه بدونه |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | اختياري | JSON حساب خدمة Google (يمكن بصيغة base64) |
| `WORKER_URL` و `WORKER_SHARED_SECRET` | اختياري | عامل Instaloader على جهازك عبر نفق |
| `DRAIN_BUDGET_SECONDS` | | افتراضياً 240، ويجب أن يكون أقل من `maxDuration` (300) |

4. اضغط **Deploy**.

إذا رفض Vercel مدة `maxDuration = 300` في خطتك، خفّضها في ملفات `app/api/**/route.ts` وخفّض `DRAIN_BUDGET_SECONDS` معها.

## الخطوة 3 — ربط Claude

**claude.ai:** الإعدادات ← الموصّلات ← إضافة موصّل مخصّص ← الصق `https://<موقعك>/api/mcp`.
سيفتح صفحة دخول اللوحة، ثم صفحة "السماح بالوصول". بعد الموافقة تظهر الأدوات الثماني في المحادثة.

**Claude Code:** أنشئ مفتاح API من صفحة الإعدادات في اللوحة، ثم:
```bash
claude mcp add --transport http scrapers https://<موقعك>/api/mcp --header "Authorization: Bearer sk_..."
```

**Claude Desktop محلياً** (بدون Vercel):
```json
{ "mcpServers": { "scrapers": { "command": "node", "args": ["/path/to/spir-scraper/apps/cli/dist/bin.js", "mcp"], "cwd": "/path/to/spir-scraper" } } }
```

## الخطوة 4 — Google Sheets (اختياري)

1. في Google Cloud Console: فعّل **Google Sheets API** و **Google Drive API**، وأنشئ **Service Account** ونزّل مفتاح JSON.
2. ضع محتوى الملف في `GOOGLE_SERVICE_ACCOUNT_JSON`.
3. **الطريقة الأضمن:** أنشئ شيتاً بنفسك، وشاركه مع إيميل حساب الخدمة كمحرر (يظهر في صفحة الإعدادات)، ثم ضع معرّف الشيت في المشروع. التصدير بعدها يضيف الصفوف أو تبويباً جديداً.
4. خيار "شيت جديد" يجعل حساب الخدمة مالك الملف. بعض حسابات الخدمة الحديثة ليس لها مساحة على Drive، فيفشل هذا الخيار برسالة واضحة. استخدم عندها الطريقة الأضمن.

## كيف تُعالَج المهام بدون عامل دائم

- عند بدء مهمة من اللوحة أو الـ API أو Claude، تبدأ المعالجة بعد إرسال الرد (`after()` في Next.js) لمدة 240 ثانية تقريباً.
- إن بقي عمل، يستدعي التطبيق نفسه على `/api/jobs/drain` بـ `CRON_SECRET` ليكمل في استدعاء جديد.
- صفحة المهمة المفتوحة، وكل طلب MCP، يدفعان المعالجة أيضاً.
- مهمة cron يومية (`/api/cron`) تنظّف العملاء المنتهية مدتهم، وتجمع نتائج تقييم الدفعات، وتكمل أي مهمة عالقة.
