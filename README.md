# Scrapers

منصة لجمع العملاء المحتملين من البيانات العامة على إنستقرام. تتكون من نواة واحدة، وتعمل من الطرفية (CLI) أو عبر REST API أو خادم MCP لـ Claude أو لوحة ويب، وتصدّر النتائج إلى Google Sheets أو CSV أو XLSX.

- الخطة المتكاملة: [docs/PLAN.md](docs/PLAN.md)
- المراجع مفتوحة المصدر: [docs/references.md](docs/references.md)
- ملاحظات المتطلبات: [docs/PROJECT_NOTES.md](docs/PROJECT_NOTES.md)

## التشغيل المحلي

المتطلبات: Node.js 22.12 أو أحدث (يُفضّل 24)، و pnpm 10، و Docker.

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres     # Postgres محلي على المنفذ 5432
pnpm db:migrate                   # تطبيق الـ migrations
pnpm lint && pnpm build && pnpm typecheck && pnpm test
```

لاستخدام Supabase بدل Postgres المحلي، ضع رابطَي الاتصال في `DATABASE_URL` و `DIRECT_DATABASE_URL`.

بعد تعديل `packages/db/src/schema.ts` شغّل `pnpm db:generate` لتوليد migration جديد.

## هيكل المستودع

```
apps/              # cli و api و mcp و web (من المرحلة 1)
packages/db/       # مخطط Drizzle والـ migrations
services/          # ig-worker بلغة Python (من المرحلة 1)
docs/              # الخطة والمراجع
```
