# النشر على Vercel

المستودع جاهز للنشر: لوحة التحكم، والـ REST API، وخادم MCP لـ Claude، و OAuth كلها في تطبيق واحد هو `apps/web`. قاعدة البيانات Postgres على Neon أو Supabase، والاثنان يعملان بلا تغيير في الكود.

## ما يعمل على Vercel وما لا يعمل

| الجزء | على Vercel | ملاحظة |
|---|---|---|
| اللوحة + API + MCP + OAuth | ✅ | تطبيق Next.js واحد |
| معالجة المهام | ✅ | بدون عامل دائم: تُعالَج بعد كل طلب وتسلّم نفسها لاستدعاء جديد حتى تنتهي، ومهمة cron يومية كشبكة أمان |
| Apify (الاكتشاف والجلب) | ✅ | الطريقة الموصى بها على Vercel |
| عامل Instaloader (Python) | ❌ | خوادم Vercel عناوين مراكز بيانات يحجبها إنستقرام بسرعة. شغّله على جهاز في البيت بأمر واحد عبر Cloudflare Tunnel: [docs/HOME-WORKER.md](HOME-WORKER.md) |

> **تنبيه الخطة المجانية:** خطة Hobby في Vercel مخصصة للاستخدام الشخصي غير التجاري حسب شروطهم. للاستخدام التجاري تحتاج خطة Pro. راجع شروط Vercel الحالية.

## الخطوة 1 — قاعدة البيانات: Neon أو Supabase

اختر واحدة منهما.

### الخيار أ: Neon (الأسهل مع Vercel)

**الطريقة الأسرع:** من مشروعك في Vercel: **Storage → Create Database → Neon**، ثم اربطها بالمشروع. يضيف Vercel المتغيرات بنفسه:
- `DATABASE_URL`: الرابط الذي يمر عبر الـ pooler (فيه `-pooler` في اسم المضيف)
- `DATABASE_URL_UNPOOLED`: الرابط المباشر

التطبيق يستخدم `DATABASE_URL_UNPOOLED` للطابور والجداول تلقائياً إن لم تضع `DIRECT_DATABASE_URL`، فلا تنسخ شيئاً يدوياً.

إن وضعت **Custom Prefix** عند الربط، تصبح الأسماء مثل `NEON_DATABASE_URL`. التطبيق يقرأ البادئتين `NEON_` و `STORAGE_` تلقائياً. لأي بادئة أخرى أضف `DATABASE_ENV_PREFIX` بقيمتها، مثلاً `MYDB`.

**أو يدوياً:** أنشئ مشروعاً على neon.tech، ومن **Connect** خذ:
- الرابط مع **Connection pooling** مفعّلاً ← `DATABASE_URL`
- الرابط مع **Connection pooling** مطفأً ← `DIRECT_DATABASE_URL`

ملاحظات:
- Neon يطفئ قاعدة البيانات بعد فترة خمول ويوقظها مع أول طلب، فقد يتأخر أول طلب بعد الخمول قليلاً. هذا طبيعي.
- راجع حدود الخطة المجانية الحالية في صفحة أسعار Neon. ضع حد التخزين في `DB_SIZE_LIMIT_MB` ليُحسب شريط حجم قاعدة البيانات في صفحة الإعدادات صحيحاً.
- **الجداول تُنشأ تلقائياً:** كل بناء إنتاج على Vercel يطبّق الـ migrations قبل البناء (`migrate --if-configured` في `apps/web/vercel.json`)، ويتخطاها إن لم تكن قاعدة البيانات مربوطة بعد. لا تحتاج تشغيل أي شيء من جهازك. لتطبيقها يدوياً من جهازك إن أردت:
  ```bash
  DIRECT_DATABASE_URL="postgres://...neon.tech/neondb?sslmode=require" pnpm db:migrate
  ```

### الخيار ب: Supabase

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
   > إذا عرض Vercel عند الاستيراد **عدة خدمات** (Next.js و FastAPI و Hono وغيرها)، فلا تنشرها كلها. اضغط **Edit** بجانب Root Directory واختر `apps/web`، فيبني اللوحة وحدها. العامل (Python) لا يُنشر على Vercel، والـ API و MCP جزء من اللوحة نفسها.
   - **يبني Vercel فرع `main` فقط:** `ignoreCommand` في `vercel.json` يتخطى بناء أي فرع آخر، مثل فروع العمل وطلبات Dependabot، فلا تُستهلك دقائق البناء على نسخ تجريبية.
3. أضف متغيرات البيئة (Settings → Environment Variables):

| المتغير | إلزامي | القيمة |
|---|---|---|
| `DATABASE_URL` | ✅ | الرابط عبر الـ pooler (Neon: يضيفه التكامل تلقائياً، Supabase: Transaction pooler) |
| `DIRECT_DATABASE_URL` | ✅ | الرابط المباشر (Neon: يكفي `DATABASE_URL_UNPOOLED` من التكامل، Supabase: Session pooler) |
| `DB_SIZE_LIMIT_MB` | | حد تخزين خطتك، لشريط الحجم في الإعدادات (افتراضياً 500) |
| `SUPPRESSION_PEPPER` | ✅ | `openssl rand -hex 32` (لا تغيّره بعد البدء) |
| `AUTH_SECRET` | ✅ | `openssl rand -hex 32` (تغييره يُلغي كل الجلسات والرموز) |
| `DASHBOARD_PASSWORD` | ✅ | كلمة مرور اللوحة، 8 أحرف على الأقل (يُفضّل أطول) |
| `CRON_SECRET` | ✅ | `openssl rand -hex 32`، و Vercel يرسله تلقائياً مع مهام cron |
| `TELEGRAM_BOT_TOKEN` و `TELEGRAM_CHAT_ID` | مستحسن | الإشعارات على تلكرام، وكود الدخول بخطوتين |
| `VAPID_PUBLIC_KEY` و `VAPID_PRIVATE_KEY` | اختياري | إشعارات المتصفح والموبايل. تُولَّد بـ `pnpm scrapers push-keys` |
| `PROFILE_CACHE_DAYS` | | إعادة استخدام الملف المجلوب خلال هذه الأيام (افتراضياً 30). يوفّر رصيد Apify لأن المنافسين يتشاركون كثيراً من المتابعين |
| `WEEKLY_SUMMARY_DAY` و `TIME_ZONE` | | يوم الملخص الأسبوعي (5 = الجمعة) والمنطقة الزمنية (افتراضياً Asia/Baghdad) |
| `MCP_RATE_PER_MINUTE` | | حد طلبات MCP في الدقيقة (افتراضياً 120) |
| `TWO_FACTOR` | | `off` لإطفاء كود الدخول عند الطوارئ |
| `CANARY_USERNAME` | | حساب عام يُفحص به كل مصدر يومياً (افتراضياً `instagram`) |
| `OWNER_EMAIL` | مستحسن | إيميلك، وتُشارَك معه الشيتات الجديدة |
| `APP_URL` | مستحسن | رابط النشر النهائي، مثل `https://scrapers.vercel.app` |
| `APIFY_TOKEN` | للاكتشاف | من حسابك في Apify |
| `APIFY_MONTHLY_CAP_USD` | | `0` = الرصيد المجاني فقط |
| `APIFY_RECENT_POSTS` | | عدد منشورات المنافس التي يُجمع المعلّقون عليها (افتراضياً 20) |
| `APIFY_FOLLOWERS_ACTOR` | | خدمة Apify لجرد المتابعين (افتراضياً `apify~instagram-followers-following-scraper`، ولا تحتاج تسجيل دخولك) |
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
- مهمة cron يومية (`/api/cron`) تنظّف العملاء المنتهية مدتهم، وتجمع نتائج تقييم الدفعات، وتكمل أي مهمة عالقة، وترسل **تذكيرات المتابعة** المستحقة اليوم (في الجرس وتلكرام).

## منطقة الخادم وقاعدة البيانات

كل استعلام يقطع المسافة بين خادم Vercel وقاعدة Neon، فإن كانا في قارتين مختلفتين صار التنقل ثقيلاً. صفحة **الإعدادات ← صحة النظام** تعرض المنطقتين، وتنبّهك إن اختلفتا وتقترح السطر المناسب لـ `apps/web/vercel.json`، مثل:

```json
"regions": ["fra1"]
```

## لوحة العملاء والمتابعة والصرف

- **لوحة الأعمدة** (`/leads/board`): أعمدة الحالات (جديد، تم التواصل، مهتم، عميل، مرفوض). تسحب البطاقة بين الأعمدة، أو تختار العمود من القائمة تحتها.
- **تذكير المتابعة:** عمود «متابعة» في جدول العملاء؛ تختار يوماً فيصلك تذكير صباح ذلك اليوم. لا يُذكَّر بمن صار عميلاً أو مرفوضاً.
- **رسالة واتساب:** في إعدادات المشروع تكتب قالب رسالة (`{name}` و `{username}`)، فيظهر رابط واتساب بجانب الأرقام المؤكدة فقط. الرابط يفتح واتساب والرسالة مكتوبة، وأنت من يضغط إرسال.
- **الصرف هذا الشهر** (في الإعدادات): رصيد Apify المستخدم من المسموح، وتقدير تكلفة التقييم بالذكاء الاصطناعي.

## أوامر تلكرام

بعد ضبط `TELEGRAM_BOT_TOKEN` و `TELEGRAM_CHAT_ID` و `APP_URL` (رابط https)، اضغط **«فعّل أوامر البوت»** في صفحة الإعدادات. بعدها ترسل للبوت:

- `/run https://instagram.com/competitor 200`: مهمة جديدة
- `/run @a @b @c`: حسابات محددة
- `/status`، و `/top 10`، و `/stats`
- `/project اسم`: يختار المشروع الذي تعمل عليه الأوامر

البوت يرد على محادثتك أنت فقط، ويتجاهل أي شخص آخر.

## عامل Instaloader مع بروكسي

الطريقة الموصى بها: جهاز في البيت مع Cloudflare Tunnel، والتفاصيل في [docs/HOME-WORKER.md](HOME-WORKER.md).

على أي خادم آخر: ضع `PROXY_URLS` (بروكسيات سكنية مفصولة بفواصل، تُدوَّر تلقائياً عند الحجب) و `JITTER_SECONDS` (افتراضياً 2) في بيئة العامل، ثم اربطه بـ `WORKER_URL`.
