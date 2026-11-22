# Scrapers

منصة لجمع العملاء المحتملين من البيانات العامة على إنستقرام. تتكون من نواة واحدة، وتعمل من الطرفية (CLI) أو عبر REST API أو خادم MCP لـ Claude أو لوحة ويب، وتصدّر النتائج إلى Google Sheets أو CSV أو XLSX.

- **النشر على Vercel وربط Claude:** [docs/DEPLOY-VERCEL.md](docs/DEPLOY-VERCEL.md)
- **إضافة المتصفح (مساعد بالذكاء الاصطناعي):** [docs/EXTENSION.md](docs/EXTENSION.md)
- **سجل العمل (المراجعة والإصلاحات والنشر):** [docs/WORKLOG.md](docs/WORKLOG.md)
- الخطة المتكاملة: [docs/PLAN.md](docs/PLAN.md) (القسم 14-ب: الأفكار المأخوذة من بوت Spir)
- المراجع مفتوحة المصدر: [docs/references.md](docs/references.md)
- ملاحظات المتطلبات: [docs/PROJECT_NOTES.md](docs/PROJECT_NOTES.md)

## التشغيل المحلي

المتطلبات: Node.js 22.12 أو أحدث (يُفضّل 24)، و pnpm 12، و Docker.

```bash
pnpm install && pnpm build
cp .env.example .env              # عبّئ SUPPRESSION_PEPPER و WORKER_SHARED_SECRET (openssl rand -hex 32)
docker compose up -d              # Postgres + عامل Instaloader
pnpm db:migrate
```

لاستخدام Neon أو Supabase بدل Postgres المحلي، ضع رابطَي الاتصال في `DATABASE_URL` و `DIRECT_DATABASE_URL` (مع Neon على Vercel يكفي التكامل، فهو يضع `DATABASE_URL_UNPOOLED` ويقرؤه التطبيق تلقائياً). الطابور (pg-boss) يستخدم `DIRECT_DATABASE_URL`، لأنه يحتاج اتصالاً مباشراً لا يمر عبر الـ pooler.

## الاستخدام من الطرفية

```bash
pnpm scrapers project create "وكلاء الخليج" --retention 90

# الطريقة المجانية: رفع قائمة معرّفات (عمود username أو روابط حسابات)
pnpm scrapers run accounts.csv -p "وكلاء الخليج" -l 500 -f xlsx -o leads.xlsx

# من رابط منافس أو منشور أو هاشتاق: يتطلب APIFY_TOKEN (ضمن الرصيد المجاني)
pnpm scrapers run https://instagram.com/competitor -p "وكلاء الخليج" -l 200

pnpm scrapers leads -p "وكلاء الخليج" --business --has-phone
pnpm scrapers export -p "وكلاء الخليج" -f csv -o leads.csv
pnpm scrapers suppress --phone +966501234567     # إيقاف وحذف
pnpm scrapers job start <source> -p <project>    # إضافة مهمة للطابور فقط
pnpm scrapers worker                             # معالجة الطابور باستمرار
pnpm scrapers score <job> -c "وكيل محتمل في الخليج"  # تقييم بالذكاء الاصطناعي
pnpm scrapers report <job>                       # تقرير الجمهور
pnpm scrapers export -p <project> -f sheet       # إلى Google Sheets
pnpm scrapers keys create n8n -s read,write      # مفتاح للـ API و MCP
pnpm scrapers mcp                                # خادم MCP محلي (stdio) لـ Claude Desktop/Code
pnpm scrapers leads -p <project> --status interested -q coach   # تصفية وبحث
pnpm scrapers lead status @user contacted -p <project> --note "..."
pnpm scrapers project set <project> --auto-export --keywords "وكيل, IB"
pnpm scrapers monitor add @competitor -p <project> -e 7          # مراقبة منافس (الجدد فقط)
pnpm scrapers push-keys                          # مفاتيح إشعارات المتصفح
pnpm scrapers doctor --live                      # فحص الإعداد والمصادر
```

## اللوحة محلياً

```bash
pnpm build && cd apps/web && pnpm dev      # http://localhost:3000 (يقرأ .env من apps/web)
```

## الاختبارات

```bash
pnpm lint && pnpm typecheck && pnpm test                  # TypeScript
cd services/ig-worker && uv run pytest && uv run ruff check .   # Python
```

بعد تعديل `packages/db/src/schema.ts` شغّل `pnpm db:generate` لتوليد migration جديد.

## هيكل المستودع

```
apps/web/              # Next.js: اللوحة + /api/v1 + /api/mcp + OAuth (Vercel)
apps/cli/              # أمر scrapers (يشمل خادم MCP المحلي)
apps/extension/        # إضافة Chrome: لوحة جانبية بذكاء اصطناعي (Claude/OpenAI/Gemini/محلي)
packages/core/         # المهام والاستخراج والموجّه والإيقاف
packages/providers/    # worker (Instaloader) و Apify
packages/exporters/    # CSV و XLSX و Google Sheets
packages/ai/           # التقييم بـ Claude (Haiku) والتقرير (Sonnet)
packages/mcp/          # أدوات وموارد MCP
packages/api/          # REST API (Hono + OpenAPI)
packages/runtime/      # يجمع كل شيء من متغيرات البيئة
packages/db/           # مخطط Drizzle والـ migrations
services/ig-worker/    # Python 3.14 + FastAPI + Instaloader
docs/                  # الخطة والمراجع
```
