# Scrapers

منصة لجمع العملاء المحتملين من البيانات العامة على إنستقرام. تتكون من نواة واحدة، وتعمل من الطرفية (CLI) أو عبر REST API أو خادم MCP لـ Claude أو لوحة ويب، وتصدّر النتائج إلى Google Sheets أو CSV أو XLSX.

- الخطة المتكاملة: [docs/PLAN.md](docs/PLAN.md)
- المراجع مفتوحة المصدر: [docs/references.md](docs/references.md)
- ملاحظات المتطلبات: [docs/PROJECT_NOTES.md](docs/PROJECT_NOTES.md)

## التشغيل المحلي

المتطلبات: Node.js 22.12 أو أحدث (يُفضّل 24)، و pnpm 10، و Docker.

```bash
pnpm install && pnpm build
cp .env.example .env              # عبّئ SUPPRESSION_PEPPER و WORKER_SHARED_SECRET (openssl rand -hex 32)
docker compose up -d              # Postgres + عامل Instaloader
pnpm db:migrate
```

لاستخدام Supabase بدل Postgres المحلي، ضع رابطَي الاتصال في `DATABASE_URL` و `DIRECT_DATABASE_URL`. الطابور (pg-boss) يستخدم `DIRECT_DATABASE_URL`، لأنه يحتاج اتصالاً مباشراً لا يمر عبر الـ pooler.

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
```

## الاختبارات

```bash
pnpm lint && pnpm typecheck && pnpm test                  # TypeScript
cd services/ig-worker && uv run pytest && uv run ruff check .   # Python
```

بعد تعديل `packages/db/src/schema.ts` شغّل `pnpm db:generate` لتوليد migration جديد.

## هيكل المستودع

```
apps/cli/              # أمر scrapers
packages/core/         # المهام والاستخراج والموجّه والإيقاف
packages/providers/    # worker (Instaloader) و Apify
packages/exporters/    # CSV و XLSX
packages/db/           # مخطط Drizzle والـ migrations
services/ig-worker/    # Python 3.14 + FastAPI + Instaloader
docs/                  # الخطة والمراجع
```
