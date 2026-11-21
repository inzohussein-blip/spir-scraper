# مشروع Scrapers — الخطة المتكاملة

> النسخة 1.0 · 2026-11-21
> هذه الخطة تدمج ثلاثة مصادر: خطة البناء المرفوعة، وملاحظات جمع المتطلبات (`docs/PROJECT_NOTES.md`)، ومراجعة جدوى لكل مصدر بيانات. المراجع المفتوحة المصدر محفوظة في `docs/references.md`.

---

## 0. الملخص التنفيذي

**Scrapers** منصة لجمع العملاء المحتملين من إنستقرام. تلصق رابط حساب منافس أو منشور أو هاشتاق، فتجمع المنصة الحسابات المرتبطة به، وتستخرج منها البيانات المنشورة علناً، ثم تصنّفها بالذكاء الاصطناعي وتصدّرها إلى Google Sheets أو إلى ملف.

البناء قائم على نواة واحدة (core) فيها كل المنطق، وفوقها أربع واجهات رقيقة:

| الواجهة | التقنية | الاستخدام |
|---|---|---|
| CLI ولوحة ويب | أمر `scrapers` و Next.js | تشغيل يدوي |
| REST API | Hono مع مفاتيح API | الربط مع n8n أو أي نظام آخر |
| MCP | خادم MCP يعمل محلياً (stdio) أو عن بُعد (Streamable HTTP) | Claude وأي عميل MCP |
| AI | طبقة تصنيف وتنقيط | فرز العملاء حسب جودتهم |

### القرارات المحسومة في هذه الخطة

1. **تبدأ المرحلة الأولى بمزوّدين معاً:** Instaloader المجاني لجلب الملفات العامة وإثرائها، و Apify المدفوع لاكتشاف الحسابات المتفاعلة مع المنافس. السبب مشروح في القسم 4، وهو أهم نتيجة في مراجعة الجدوى: **اكتشاف المتفاعلين بدون تسجيل دخول غير ممكن عملياً بالمكتبات المفتوحة**.
2. **Claude هو لوحة التحكم الأولى.** خادم MCP يأتي في المرحلة الثانية، قبل لوحة الويب.
3. **البيانات العامة فقط.** لا نطلب كلمة مرور إنستقرام، ولا نتجاوز CAPTCHA. وسائل التواصل تُحفظ للحسابات التجارية وحسابات المؤثرين فقط.
4. **قاعدة بيانات واحدة:** Postgres على Supabase. الطابور (pg-boss) يعمل داخلها أيضاً، فلا نحتاج Redis.

---

## 1. الأهداف والنطاق

### داخل النطاق (الإصدار 1)
- المصادر: حساب منافس، أو منشور، أو هاشتاق، أو قائمة معرّفات يرفعها المستخدم (CSV).
- استخراج: المعرّف، والاسم، والبايو، وعدد المتابعين، والتصنيف، والرابط الخارجي، والإيميل والهاتف إن كانا معلنين.
- إزالة التكرار، وقائمة إيقاف (suppression)، وحذف تلقائي بعد مدة.
- تصنيف وتنقيط بالذكاء الاصطناعي حسب معايير يكتبها المستخدم بنص حر.
- التصدير إلى CSV أو XLSX أو شيت Google جديد أو شيت موجود.
- الواجهات الأربع.

### خارج النطاق (الإصدار 1)
- إرسال الرسائل أو الإيميلات الجماعية، أي أتمتة التواصل.
- تسجيل الدخول بحسابات إنستقرام، أو تدوير حسابات وهمية.
- منصات أخرى. المعمارية تسمح بإضافتها لاحقاً، مثل TikTok، بكتابة مزوّد جديد فقط.
- نظام مستخدمين متعدد مع اشتراكات (SaaS). يأتي في المرحلة الرابعة.

### مؤشرات النجاح
| المؤشر | الهدف |
|---|---|
| زمن مهمة من 500 حساب | أقل من 15 دقيقة |
| نسبة الحسابات التجارية التي نجد لها وسيلة تواصل | 40% أو أكثر |
| دقة التصنيف بالـ AI (عيّنة يدوية من 100 حساب) | 85% أو أكثر |
| مهام تفشل بسبب الحظر | أقل من 5% بفضل التحويل التلقائي بين المزوّدين |

---

## 2. الامتثال (ملخص ملزم للتنفيذ)

> لست محامياً. راجع محامياً قبل أي استخدام تجاري.

| القاعدة | كيف تُطبَّق في الكود |
|---|---|
| البيانات العامة فقط | لا يوجد في أي مزوّد حقل لكلمة مرور إنستقرام أو كوكيز جلسة |
| أقل قدر من البيانات | الحسابات الشخصية تُحفظ بمعرّفها وتصنيفها فقط، و `email` و `phone` لها تبقى `NULL` بقيد في قاعدة البيانات |
| مصدر مسجّل لكل عميل | العمودان `job_id` و `contact_source` إلزاميان |
| حذف تلقائي | `expires_at = fetched_at + retention_days`، ومهمة pg-boss يومية تحذف المنتهي |
| حق الحذف | الأداة `suppress` تحذف السجل، وتحفظ hash للمعرّف حتى لا يُجمع مرة أخرى |
| لا تجاوز للحمايات | استجابة 429 أو صفحة تسجيل دخول توقف المهمة وتنقلها لمزوّد آخر، ولا نعيد المحاولة بإلحاح |
| الترويج المالي | تنبيه ظاهر في اللوحة وفي وصف خادم MCP بأن التواصل غير المطلوب بشأن منتجات مالية قد يخالف قواعد الجهات الرقابية وشروط الوسطاء |

---

## 3. المعمارية

```mermaid
flowchart TB
  subgraph Interfaces["الواجهات"]
    CLI["CLI<br/>apps/cli"]
    WEB["لوحة الويب<br/>apps/web"]
    API["REST API<br/>apps/api"]
    MCP["خادم MCP<br/>apps/mcp"]
  end

  CORE["النواة packages/core<br/>المهام · التطبيع · الاستخراج · الإيقاف"]

  subgraph Providers["المزوّدون packages/providers"]
    P1["Graph API<br/>Business Discovery"]
    P2["Apify"]
    P3["ig-worker<br/>Python + Instaloader"]
  end

  DB[("Postgres / Supabase<br/>+ pg-boss")]
  AI["packages/ai<br/>Claude"]
  EXP["packages/exporters<br/>CSV · XLSX · Sheets"]

  CLI --> CORE
  WEB --> API
  API --> CORE
  MCP --> CORE
  CORE <--> DB
  CORE --> P1 & P2 & P3
  CORE --> AI
  CORE --> EXP
```

### دورة حياة المهمة

```
start_job ─► jobs(status=queued) ─► pg-boss: "discover"
   │
   ▼
discover   : المزوّد يعيد قائمة معرّفات (المتفاعلون، المعلّقون، المنشورون بالهاشتاق)
   │         ─► pg-boss: "enrich" على دفعات من 50
   ▼
enrich     : getProfile لكل معرّف ─► profiles (upsert حسب ig_user_id)
   │
   ▼
extract    : استخراج وسيلة التواصل ─► leads (مع استبعاد من في suppression)
   │
   ▼
score?     : اختياري، تصنيف وتنقيط بالـ AI عبر Batches API
   │
   ▼
export?    : اختياري، شيت أو ملف ─► jobs(status=done, counts)
```

- **كل مرحلة مهمة مستقلة في pg-boss.** لكل مرحلة إعادة محاولة بانتظار تصاعدي (exponential backoff)، وسقف من 3 محاولات، ثم تنتقل المهمة إلى "dead letter".
- **التقدّم** يُحفظ في `jobs.counts`، مثلاً `{discovered, enriched, leads, failed}`، ويقرؤه `get_job` واللوحة.
- **الإلغاء:** `cancel_job` يضع `status=cancelled`، وكل عامل يتحقق منها قبل كل دفعة.

---

## 4. المزوّدون — مصفوفة القدرات الواقعية

هذا القسم يحسم السؤال الذي بقي مفتوحاً في الخطة السابقة: هل نبدأ بـ Instaloader أم بـ Apify؟

| القدرة | Graph API (Business Discovery) | Apify | Instaloader بدون تسجيل دخول |
|---|---|---|---|
| ملف عام لحساب تجاري | ✅ رسمي | ✅ | ✅ بمعدل منخفض |
| ملف عام لحساب شخصي | ❌ | ✅ | ✅ بمعدل منخفض |
| إيميل أو هاتف من زر التواصل | ❌ غير متاح في هذه الواجهة | ✅ في الـ Actors المخصصة للعملاء | ⚠️ أحياناً، من بيانات الملف الخام |
| منشورات المنافس | ✅ | ✅ | ✅ |
| **المعلّقون على منشور** | ❌ | ✅ | ❌ يتطلب تسجيل دخول |
| **المنشورون في هاشتاق** | ⚠️ يعيد المنشورات بدون أصحابها | ✅ | ❌ يتطلب تسجيل دخول |
| التكلفة | مجاني | مدفوع بحسب عدد النتائج | مجاني |
| المتطلبات | حساب إنستقرام تجاري + تطبيق Meta | توكن API | لا شيء |
| خطر الحظر | لا يوجد | يتحمّله المزوّد | متوسط، والمتأثر هو IP العامل |

### الاستنتاج والقرار
- **الاكتشاف (discover)** يكون عبر Apify أساساً، أو عبر **قائمة معرّفات يرفعها المستخدم** وهذا الخيار مجاني.
- **الإثراء (enrich)** يجرّب المزوّدين بالترتيب: Graph API للحسابات التجارية، ثم Instaloader، ثم Apify إذا فشل الاثنان أو كان الحد قد استُنفد.
- **الموجّه (router)** في النواة يختار المزوّد حسب ثلاثة أمور: هل المزوّد يدعم هذه القدرة، وهل بقي له رصيد من الطلبات في الدقيقة، وما تكلفته.

### الواجهة الموحّدة (TypeScript)

```ts
// packages/providers/src/types.ts
export type Capability =
  | "profile" | "business_contact" | "post_commenters"
  | "hashtag_posters" | "account_posts";

export interface Provider {
  id: "graph" | "apify" | "worker";
  capabilities: ReadonlySet<Capability>;
  ratePerMinute: number;
  costPer1k?: number;                       // بالدولار، لعرض التكلفة قبل التشغيل
  getProfile(username: string): Promise<RawProfile>;
  listEngagers(src: Source, limit: number): AsyncIterable<string>; // معرّفات
}
```

إذا أعاد مزوّد الخطأ `RateLimitedError` أو `BlockedError`، ينقل الموجّه الدفعة إلى المزوّد التالي، ويوقف المزوّد الأول مؤقتاً (cooldown).

---

## 5. حزمة التقنيات

> نتحقق من الإصدارات بأمر `pnpm outdated` و `uv lock --upgrade` عند بدء كل مرحلة.

| الطبقة | التقنية |
|---|---|
| المستودع | pnpm workspaces + Turborepo |
| التشغيل | Node.js 24 LTS، مع الترقية إلى 26 LTS بعد التأكد من توافق المكتبات. TypeScript 5.x في الوضع strict |
| التحقق من المدخلات | Zod v4، ومخطط واحد مشترك بين الـ API وأدوات MCP والـ CLI |
| الـ API | Hono + `@hono/zod-openapi`، ويولّد توثيق OpenAPI تلقائياً |
| MCP | MCP TypeScript SDK v2 (`@modelcontextprotocol/server`)، مواصفات 2026-07-28 |
| الـ CLI | `citty` أو `commander`، مع `@clack/prompts` للتفاعل |
| اللوحة | Next.js 16 (App Router) + Tailwind v4 + shadcn/ui، بواجهة RTL عربية |
| العامل | Python 3.14 + uv + FastAPI + httpx + Instaloader 4.15.x |
| قاعدة البيانات | Supabase Postgres + Drizzle ORM و drizzle-kit |
| الطابور | pg-boss |
| استخراج الهاتف | libphonenumber-js |
| التصدير | ExcelJS، ومولّد CSV، و googleapis (Sheets v4 و Drive v3) |
| الذكاء الاصطناعي | `@anthropic-ai/sdk`: Haiku 5.5 للتصنيف عبر Batches API، و Sonnet 5.5 للتقارير |
| الجودة | Biome، و Vitest، و pytest، و Playwright للوحة |
| السجلات والمراقبة | pino (سجلات JSON)، و OpenTelemetry، و Sentry |
| النشر | Docker على Railway |

---

## 6. نموذج البيانات

```sql
create table projects (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  owner           text not null,
  sheet_id        text,                       -- شيت موجود (اختياري)
  ai_criteria     text,                       -- معايير التنقيط بنص حر
  retention_days  int  not null default 90,
  created_at      timestamptz not null default now()
);

create type source_type as enum ('profile','post','hashtag','upload');
create type job_status  as enum ('queued','running','done','failed','cancelled');

create table jobs (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects on delete cascade,
  source_type  source_type not null,
  source_url   text not null,
  "limit"      int  not null check ("limit" between 1 and 5000),
  provider     text,                          -- المزوّد الذي استُخدم فعلاً
  status       job_status not null default 'queued',
  counts       jsonb not null default '{}',
  cost_usd     numeric(10,4) default 0,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now()
);

create table profiles (
  ig_user_id    text primary key,
  username      text not null unique,
  full_name     text,
  bio           text,
  followers     int,
  following     int,
  posts         int,
  is_business   boolean not null default false,
  is_verified   boolean not null default false,
  category      text,
  external_url  text,
  fetched_at    timestamptz not null default now(),
  fetched_by    text not null                -- graph | apify | worker
);

create type contact_source as enum ('business_button','bio','link');

create table leads (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects on delete cascade,
  profile_id      text not null references profiles on delete cascade,
  job_id          uuid not null references jobs on delete cascade,
  email           text,
  phone_e164      text,
  contact_source  contact_source,
  ai_score        smallint check (ai_score between 0 and 100),
  ai_tags         text[],
  ai_reason       text,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  unique (project_id, profile_id)
);

create table suppression (
  value_hash  text primary key,               -- sha256(normalize(value) + pepper)
  kind        text not null check (kind in ('username','email','phone')),
  reason      text,
  created_at  timestamptz not null default now()
);

create table api_keys (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  key_hash    text not null unique,
  scopes      text[] not null default '{read}',
  last_used   timestamptz,
  created_at  timestamptz not null default now()
);

create index on leads (project_id, ai_score desc);
create index on leads (expires_at);
create index on jobs  (project_id, created_at desc);
```

**قاعدة الحسابات الشخصية:** قيد الحسابات الشخصية يُفرض في النواة قبل الكتابة. لا نستطيع فرضه كقيد CHECK في قاعدة البيانات لأن `is_business` موجود في جدول آخر. ونغطيه باختبار وحدة إلزامي.

---

## 7. مسار استخراج وسيلة التواصل

```
RawProfile
  │
  ├─ 1. حساب تجاري وله زر تواصل؟ ─► email/phone، و contact_source = business_button
  │
  ├─ 2. حساب تجاري أو مؤثر (10k متابع أو أكثر، أو موثّق)؟
  │       نطبّع البايو: نحوّل الأرقام العربية الهندية (٠١٢) والفارسية (۰۱۲) إلى لاتينية،
  │       ونزيل الإيموجي الفاصل، ونحوّل "at" و "dot" إلى @ و .
  │       ─► regex للإيميل، و findPhoneNumbersInText (libphonenumber-js)
  │          مع دولة افتراضية للمشروع ─► E.164
  │       contact_source = bio
  │
  ├─ 3. الرابط الخارجي من نوع linktree أو wa.me أو mailto؟
  │       نحلل الرابط نفسه فقط، ولا نزحف داخل المواقع
  │       ─► contact_source = link
  │
  ├─ 4. التحقق: صيغة الإيميل + سجل MX للنطاق (مع تخزين مؤقت)، وصلاحية الرقم
  │
  ├─ 5. نستبعد ما يطابق hash في suppression
  │
  └─ 6. حساب شخصي؟ ─► نحفظ lead بدون email و phone (للتصنيف فقط)
```

كل خطوة دالة نقية (pure function) في `packages/core/src/extract/`، ولها اختبارات مبنية على ملفات نماذج (fixtures) تحتوي بايوهات حقيقية الشكل بالعربية والإنجليزية.

---

## 8. الواجهات

### 8.1 الـ CLI

```bash
scrapers project create "وكلاء الخليج" --retention 90 --sheet <id>
scrapers job start https://instagram.com/competitor --type profile --limit 500 --project <id>
scrapers job start ./usernames.csv --type upload --project <id>
scrapers job status <job_id> --watch
scrapers leads list --project <id> --business --has-email --min-score 70
scrapers score <job_id> --criteria "وكيل محتمل في الخليج، يتحدث العربية"
scrapers export <job_id> --format xlsx|csv|sheet [--sheet <id>]
scrapers suppress --email a@b.com
scrapers worker                  # تشغيل عمّال pg-boss محلياً
```

### 8.2 الـ REST API (`/v1`)

| الطريقة | المسار | النطاق (scope) |
|---|---|---|
| POST | `/projects` | write |
| GET | `/projects/:id` | read |
| POST | `/jobs` | write |
| GET | `/jobs/:id` | read |
| POST | `/jobs/:id/cancel` | write |
| POST | `/jobs/:id/score` | write |
| POST | `/jobs/:id/export` | write |
| GET | `/leads?project=&business=&has_email=&min_score=&cursor=` | read |
| GET | `/profiles/:username` | read |
| POST | `/suppression` | write |
| GET | `/openapi.json` ، `/docs` | عام |

- المصادقة بترويسة `Authorization: Bearer sk_...`. المفتاح يُخزَّن hash فقط.
- حد للطلبات لكل مفتاح، وترويسة `Idempotency-Key` لطلبات POST على `/jobs`.
- إشعار webhook اختياري عند انتهاء المهمة، مفيد لـ n8n.

### 8.3 خادم MCP

**الأدوات (tools):** كل أداة تستخدم نفس مخطط Zod الذي يستخدمه الـ API.

| الأداة | المدخلات | المخرجات |
|---|---|---|
| `start_job` | source_url, source_type, limit (حتى 1000), project | job_id، والتكلفة التقديرية |
| `get_job` | job_id | الحالة، والأعداد، ونسبة التقدّم |
| `cancel_job` | job_id | الحالة |
| `list_leads` | project, filters, cursor | صفحة من 50 عميلاً |
| `get_profile` | username | ملف عام واحد مع مصدره |
| `score_leads` | job_id, criteria | عدد الحسابات التي نُقّطت |
| `export_leads` | job_id, format, sheet_id? | رابط الشيت أو مسار الملف |
| `suppress` | username / email / phone | تأكيد الحذف |

**الموارد (resources):**
- `leads://{project}/latest`
- `jobs://{id}/summary`
- `projects://list`

**القوالب الجاهزة (prompts):**
- `find_partners`: يجمع الحسابات ويصنّفها ويصدّر أفضلها، في سير عمل واحد جاهز.
- `audience_report`: تقرير عن جمهور منافس.

**طرق التشغيل:**
- `stdio`: يُضاف إلى Claude Desktop أو Claude Code بأمر `npx @scrapers/mcp`.
- `Streamable HTTP` على `/mcp`: موصّل مخصّص في claude.ai، مع OAuth 2.1 أو مفتاح API.

**المهام الطويلة:** `start_job` تعود فوراً، ويتابع Claude التقدّم بـ `get_job`. نعتمد آلية المهام الطويلة في مواصفات MCP الجديدة إن كان الـ SDK يدعمها، وإلا نكتفي بالمتابعة الدورية.

### 8.4 لوحة الويب (المرحلة الثالثة)

| الصفحة | المحتوى |
|---|---|
| `/` | المشاريع وآخر المهام |
| `/jobs/new` | لصق الرابط، واختيار النوع والحد، وعرض التكلفة التقديرية قبل التشغيل |
| `/jobs/[id]` | التقدّم مباشرة (SSE)، والأعداد، والأخطاء |
| `/leads` | جدول بفلاتر وفرز حسب الدرجة، وتصدير، وإيقاف |
| `/settings` | مفاتيح API، وربط Google، ومعايير الـ AI، ومدة الاحتفاظ |

الدخول عبر Supabase Auth، بالإيميل (magic link) أو بحساب Google.

---

## 9. التصدير

| المخرج | الآلية |
|---|---|
| شيت جديد | Service Account + Sheets API: ينشئ ملفاً باسم `Scrapers – {project} – {date}`، ويثبّت صف العناوين، ويشاركه مع إيميل المالك عبر Drive API |
| شيت موجود | `spreadsheets.values.append`، بعد قراءة عمود username لتجاهل المكرّر |
| CSV | UTF-8 مع BOM حتى تظهر العربية صحيحة في Excel |
| XLSX | ExcelJS مع اتجاه RTL، وتجميد صف العناوين، وتنسيق شرطي حسب الدرجة |
| عبر Claude | Claude يقرأ `list_leads` ويكتب في الشيت بموصّل Google Sheets المربوط عنده، دون Service Account |

**الأعمدة الثابتة:** username · full_name · category · followers · email · phone · contact_source · ai_score · ai_tags · ai_reason · source_url · fetched_at

لكتابة الشيت حد يقارب 60 طلب كتابة في الدقيقة، لذلك نرسل الصفوف على دفعات من 500 صف في الطلب الواحد.

---

## 10. طبقة الذكاء الاصطناعي

- **المدخل:** الملف العام بعد تطبيعه، دون إرسال الإيميل أو الهاتف إلى النموذج لأن التصنيف لا يحتاجهما.
- **المخرج:** JSON مطابق لمخطط Zod، وما لا يطابقه يُرفض ويُعاد مرة واحدة.

```ts
const LeadScore = z.object({
  segment: z.enum(["individual_trader","educator","finance_creator",
                   "potential_partner","business","irrelevant","bot_or_fake"]),
  language: z.string(),          // ar | en | ...
  country:  z.string().nullable(),
  score:    z.number().int().min(0).max(100),
  reason:   z.string().max(200),
});
```

- **الدفعات:** Message Batches API مع Haiku 5.5، وهو أرخص بنحو 50% من الطلبات العادية. نضع التعليمات والمعايير في بداية الطلب، ونستفيد من التخزين المؤقت للتعليمات (prompt caching).
- **التقرير:** Sonnet 5.5 يكتب ملخصاً بتوزيع الفئات واللغات وأبرز المؤثرين، ويُحفظ في `jobs.counts.report`.
- **في وضع MCP** لا نحتاج مفتاح Anthropic، فـ Claude نفسه يصنّف بعد قراءة النتائج.
- **التقييم:** مجموعة من 100 حساب مصنّفة يدوياً في `packages/ai/eval/`، ونشغّلها في CI عند تعديل التعليمات.

---

## 11. الأمن والإعدادات

```env
DATABASE_URL=                 # Supabase (pooler)
DIRECT_DATABASE_URL=          # للـ migrations
SUPPRESSION_PEPPER=           # سر لتجزئة قائمة الإيقاف
APIFY_TOKEN=
META_APP_ID= / META_APP_SECRET= / IG_BUSINESS_ACCOUNT_ID= / IG_GRAPH_TOKEN=
WORKER_URL=http://ig-worker:8000
WORKER_SHARED_SECRET=
GOOGLE_SERVICE_ACCOUNT_JSON=  # base64
ANTHROPIC_API_KEY=            # اختياري
SENTRY_DSN=
MAX_JOB_LIMIT=1000
DEFAULT_RETENTION_DAYS=90
```

- **الأسرار:** تُحفظ في متغيرات Railway فقط، ولا يوجد أي سر في المستودع. ملف `.env.example` يحتوي الأسماء بدون قيم.
- **العامل:** شبكة داخلية فقط، ولا يُعرض للإنترنت. كل طلب إليه يحمل `WORKER_SHARED_SECRET`.
- **Supabase:** تفعيل Row Level Security على كل الجداول، والوصول من الخادم بدور service.
- **التحقق:** كل مدخل يمر عبر Zod، ونقبل فقط الروابط التي تطابق `instagram.com/...`، فلا يُطلب أي رابط آخر من الخادم (حماية من SSRF).
- **السجلات:** لا نكتب الإيميلات أو الأرقام في السجلات (masking).

---

## 12. الجودة والاختبار و CI

| النوع | الأداة | التغطية |
|---|---|---|
| وحدة | Vitest | الاستخراج، والتطبيع، والموجّه، والإيقاف، وقاعدة الحسابات الشخصية |
| تكامل | Vitest + Postgres في Docker | دورة المهمة كاملة بمزوّد وهمي (mock provider) |
| العقود (contracts) | ملفات JSON مسجّلة من كل مزوّد | اكتشاف تغيّر بنية الاستجابة مبكراً |
| العامل | pytest + respx | Instaloader مع ردود محفوظة |
| MCP | MCP Inspector + اختبار عميل SDK | كل أداة مع مخططها |
| واجهة | Playwright | إنشاء مهمة وتصدير |

**GitHub Actions:** فحص Biome، وفحص الأنواع (typecheck)، ثم الاختبارات، ثم بناء صور Docker، ثم النشر على Railway عند الدمج في `main`.

**فحص يومي (canary):** مهمة صغيرة على حساب معروف تتأكد أن كل مزوّد ما زال يعمل، وترسل تنبيهاً إن تعطّل أحدها.

---

## 13. النشر والتشغيل

### خدمات Railway
| الخدمة | المصدر | ملاحظات |
|---|---|---|
| `api` | `apps/api` | عام، ويستضيف أيضاً `/mcp` (Streamable HTTP) |
| `jobs` | `apps/cli worker` | عمّال pg-boss، ويمكن تشغيل أكثر من نسخة |
| `ig-worker` | `services/ig-worker` | داخلي فقط، نسخة واحدة لأن معدل طلباته منخفض |
| `web` | `apps/web` | المرحلة الثالثة، ويمكن نشرها على Vercel بدلاً من ذلك |

قاعدة البيانات على Supabase، و `docker-compose.yml` يشغّل كل شيء محلياً مع Postgres.

### المراقبة
- لوحة Sentry للأخطاء.
- مقاييس لكل مزوّد: نسبة النجاح، وعدد ردود 429، والزمن.
- تنبيه إذا تجاوزت نسبة فشل المزوّدين 20% خلال ساعة.

---

## 14. خارطة الطريق

### المرحلة 0 — التأسيس (2–3 أيام)
- [ ] هيكل المستودع (pnpm و Turborepo و Biome و tsconfig المشترك)
- [ ] `packages/db`: مخطط Drizzle وأول migration على Supabase
- [ ] `docker-compose.yml` وملف `.env.example`
- [ ] CI أساسي

**بوابة:** `pnpm build && pnpm test` ينجحان في CI.

### المرحلة 1 — نواة تعمل من الطرفية (1–2 أسبوع)
- [ ] `packages/core`: المهام، والاستخراج، والتطبيع، والإيقاف، وإزالة التكرار
- [ ] `packages/providers`: الواجهة الموحّدة، والموجّه، و Apify، و Graph API
- [ ] `services/ig-worker`: خدمة FastAPI تغلّف Instaloader، بنقطة `/profile/{username}` فقط
- [ ] مصدر `upload` (رفع قائمة CSV)
- [ ] `packages/exporters`: CSV و XLSX
- [ ] `apps/cli`: أوامر project و job و leads و export و worker

**بوابة:** مهمة من 500 حساب تنتهي بملف XLSX صحيح، وتغطية اختبارات الاستخراج 90% أو أكثر.

### المرحلة 2 — Claude والشيت (أسبوع واحد) ← أهم مرحلة
- [ ] `apps/mcp`: الأدوات الثماني والموارد والقوالب، عبر stdio
- [ ] تصدير إلى Google Sheets (شيت جديد وإضافة إلى شيت موجود)
- [ ] `packages/ai`: التصنيف والتنقيط عبر Batches API، والتقرير
- [ ] `apps/api` + Streamable HTTP على `/mcp`، ونشره على Railway

**بوابة:** من Claude، الطلب «اجمع، رتّب، ضع أفضل 50 في الشيت» يعمل من أوله لآخره.

### المرحلة 3 — اللوحة والتقوية (1–2 أسبوع)
- [ ] `apps/web` بواجهة RTL عربية، فيها الصفحات الخمس
- [ ] مفاتيح API و webhooks و OpenAPI
- [ ] الفحص اليومي للمزوّدين، والمراقبة، والحذف التلقائي
- [ ] اختبارات Playwright

**بوابة:** مستخدم غير تقني يشغّل مهمة ويصدّرها من اللوحة دون مساعدة.

### المرحلة 4 — التوسّع (لاحقاً)
- [ ] مستخدمون متعددون ومشاريع مشتركة وحصص استخدام
- [ ] مزوّدات لمنصات أخرى (TikTok و YouTube)
- [ ] قوالب n8n جاهزة

---

## 15. التكاليف التقديرية (شهرياً)

| البند | التقدير | ملاحظة |
|---|---|---|
| Railway (api و jobs و ig-worker) | 10–25$ | بحسب الاستخدام |
| Supabase | 0–25$ | الخطة المجانية تكفي في البداية |
| Apify | حسب عدد النتائج | تُعرض التكلفة التقديرية قبل كل مهمة ويُوضع سقف لكل مشروع. **نتحقق من الأسعار الحالية في صفحة كل Actor** |
| Anthropic | منخفضة | Haiku عبر Batches API، وصفر في وضع MCP |
| Google Sheets API | مجاني | ضمن الحصص |
| Sentry | مجاني | للفريق الصغير |

---

## 16. المخاطر والبدائل

| الخطر | الاحتمال | الأثر | البديل |
|---|---|---|---|
| تعطّل Instaloader بسبب تغيّر إنستقرام | عالٍ | متوسط | الموجّه ينقل الطلبات إلى Apify، والفحص اليومي ينبّه |
| حظر IP العامل (429) | متوسط | منخفض | حد منخفض للطلبات، وفترة توقف مؤقت، وتحويل للمزوّد التالي |
| تغيّر أسعار Apify أو توقف الـ Actor | متوسط | متوسط | Actor بديل في الإعدادات، ومصدر `upload` يعمل دائماً |
| ارتفاع تكلفة AI | منخفض | منخفض | Batches API والتخزين المؤقت للتعليمات، وسقف لكل مهمة |
| مطالبة قانونية أو شكوى خصوصية | منخفض–متوسط | عالٍ | البيانات العامة فقط، والإيقاف، والحذف التلقائي، ومراجعة محامٍ |
| إغلاق تطبيق Meta | منخفض | منخفض | Graph API ليس مزوّداً حرجاً |

---

## 17. أسئلة مفتوحة

1. **الدولة الافتراضية لتحليل الأرقام:** دول الخليج، أم العراق، أم غيرها؟
2. **حساب إنستقرام تجاري لـ Graph API:** هل يوجد حساب وتطبيق Meta، أم نؤجل هذا المزوّد؟
3. **ميزانية Apify الشهرية:** ما السقف الذي نضعه افتراضياً؟
4. **مستخدمو اللوحة:** أنت وحدك، أم فريق أو وكلاء؟ هذا يحدد هل نبني المرحلة 4 مبكراً.
5. **اسم الحزمة ونطاق npm:** هل نستخدم `@scrapers/*` أم اسماً آخر؟
