import { AnthropicScorer } from "@scrapers/ai";
import {
  createScrapers,
  type LeadFilters,
  type NotificationSink,
  type Provider,
  type ProviderHealthEvent,
  ProviderRouter,
  type ResolveDeps,
  type Scorer,
  type Scrapers,
} from "@scrapers/core";
import { type AnyDb, createDb, databaseUrl, directDatabaseUrl } from "@scrapers/db";
import {
  exportToSheet,
  type GoogleRequest,
  type SheetExportResult,
  type SheetMode,
  serviceAccountRequest,
  toCsv,
  toXlsx,
} from "@scrapers/exporters";
import { ApifyProvider, providersFromEnv } from "@scrapers/providers";
import { PgBoss } from "pg-boss";
import { WebPushSink } from "./push.js";
import { type FetchLike, TelegramNotifier } from "./telegram.js";

/** Which database URL the app will use, for status checks (any accepted variable name). */
export { databaseRegion, databaseUrl, directDatabaseUrl } from "@scrapers/db";
export * from "./commands.js";
export * from "./push.js";
export * from "./telegram.js";

export type ExportFormat = "csv" | "xlsx" | "sheet";

export interface ExportRequest {
  projectId: string;
  jobId?: string;
  filters?: Omit<LeadFilters, "projectId" | "jobId" | "limit" | "offset">;
  format: ExportFormat;
  /** For format "sheet". Defaults to append when the project has a sheet, else new-file. */
  sheetMode?: SheetMode;
  spreadsheetId?: string;
}

export type ExportResult =
  | { kind: "file"; filename: string; contentType: string; data: Buffer; count: number }
  | ({ kind: "sheet"; count: number } & SheetExportResult);

export interface Runtime {
  scrapers: Scrapers;
  /** Owner recorded on new projects and given access to new sheets. */
  owner: string;
  /** Service-account email to share spreadsheets with, when Sheets is configured. */
  sheetsEmail: string | null;
  exportLeads(req: ExportRequest): Promise<ExportResult>;
  /** Telegram channel to the owner (notifications, login codes), when configured. */
  telegram: TelegramNotifier | null;
  /** Public VAPID key for browser push, when configured. */
  vapidPublicKey: string | null;
  /** Daily check: free-credit level and whether each provider still answers. */
  healthCheck(): Promise<{ provider: string; ok: boolean; detail: string }[]>;
  close(): Promise<void>;
}

export interface RuntimeOverrides {
  db?: AnyDb;
  boss?: PgBoss;
  providers?: Provider[];
  scorer?: Scorer | null;
  sheetsRequest?: GoogleRequest;
  sheetsEmail?: string;
  /** Serverless hosts (Vercel): no background supervision or cron inside pg-boss. */
  serverless?: boolean;
  sinks?: NotificationSink[];
  telegramFetch?: FetchLike;
  /** Overrides the network steps of contact extraction (tests pass {}). */
  resolve?: ResolveDeps;
  onClose?: () => Promise<void>;
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function createRuntime(
  env: NodeJS.ProcessEnv = process.env,
  o: RuntimeOverrides = {},
): Promise<Runtime> {
  if (!env.SUPPRESSION_PEPPER)
    throw new Error("SUPPRESSION_PEPPER is not set (openssl rand -hex 32)");

  let ownDb: ReturnType<typeof createDb> | undefined;
  let db = o.db;
  if (!db) {
    const url = databaseUrl(env);
    if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
    ownDb = createDb(url, o.serverless ? { max: 3, idleTimeoutSeconds: 20 } : {});
    db = ownDb;
  }

  let boss = o.boss;
  const ownBoss = !boss;
  if (!boss) {
    // pg-boss needs a session connection: Supabase's session pooler or direct URL, not the transaction pooler.
    boss = new PgBoss({
      connectionString: directDatabaseUrl(env) ?? "",
      // Serverless: no background supervision, and idle connections close so
      // the database can suspend between uses.
      ...(o.serverless
        ? { supervise: false, schedule: false, max: 2, idleTimeoutMillis: 20_000 }
        : {}),
    });
    boss.on("error", (err) => console.error("[pg-boss]", err.message));
    await boss.start();
  }

  const scorer =
    o.scorer === null
      ? undefined
      : (o.scorer ?? (env.ANTHROPIC_API_KEY ? new AnthropicScorer() : undefined));

  const telegram =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, o.telegramFetch)
      : null;
  const providers = o.providers ?? providersFromEnv(env);
  // Browser push needs a store that exists only after createScrapers; the sink reads it lazily.
  let pushStore: Scrapers | null = null;
  const push =
    env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? new WebPushSink(
          () => {
            if (!pushStore) throw new Error("push store not ready");
            return pushStore;
          },
          {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject:
              env.VAPID_SUBJECT ||
              (env.OWNER_EMAIL?.includes("@")
                ? `mailto:${env.OWNER_EMAIL}`
                : "mailto:owner@example.com"),
          },
        )
      : null;
  const REASONS = {
    rate_limited: "تجاوز حد الطلبات",
    blocked: "محجوب أو يطلب تسجيل دخول",
    budget: "انتهى الرصيد",
  } as const;
  let onHealth = (_e: ProviderHealthEvent) => {};
  const router = new ProviderRouter(providers, { onHealth: (e) => onHealth(e) });

  const scrapers = createScrapers({
    db,
    boss,
    router,
    scorer,
    sinks: [...(telegram ? [telegram] : []), ...(push ? [push] : []), ...(o.sinks ?? [])],
    ...(env.APP_URL ? { appUrl: env.APP_URL } : {}),
    ...(o.resolve ? { resolve: o.resolve } : {}),
    onReadyToExport: (jobId) => autoExport(jobId),
    config: {
      suppressionPepper: env.SUPPRESSION_PEPPER,
      maxJobLimit: Number(env.MAX_JOB_LIMIT ?? 1000),
      defaultRetentionDays: Number(env.DEFAULT_RETENTION_DAYS ?? 90),
      profileCacheDays: Number(env.PROFILE_CACHE_DAYS ?? 30),
      weeklyDay: Number(env.WEEKLY_SUMMARY_DAY ?? 5),
      timeZone: env.TIME_ZONE || "Asia/Baghdad",
    },
  });

  /**
   * Auto-export (owner's choice: no score thresholds): every lead of the job,
   * with its score and status, goes to the project's sheet. A project without
   * a sheet gets a new one, remembered for later jobs.
   */
  async function autoExport(jobId: string) {
    const job = await scrapers.getJob(jobId);
    const project = await scrapers.getProject(job.projectId);
    if (!project?.autoExport) return;
    if (!sheets) {
      await scrapers.notify({
        type: "job",
        level: "warn",
        title: "التصدير التلقائي مفعّل لكن Google Sheets غير مضبوط",
        body: "أضف GOOGLE_SERVICE_ACCOUNT_JSON أو أطفئ التصدير التلقائي للمشروع.",
        url: `/jobs/${jobId}`,
        key: `auto-export-nosheets:${project.id}`,
      });
      return;
    }
    const r = await runtime.exportLeads({ projectId: project.id, jobId, format: "sheet" });
    if (r.kind !== "sheet") return;
    if (!project.sheetId) await scrapers.updateProject(project.id, { sheetId: r.spreadsheetId });
    await scrapers.notify({
      type: "job",
      level: "ok",
      title: `صُدّر ${r.written} عميلاً إلى شيت ${project.name}`,
      body: r.skippedDuplicates ? `${r.skippedDuplicates} موجودون في الشيت مسبقاً` : "",
      url: `/jobs/${jobId}`,
      key: `auto-export:${jobId}`,
    });
  }
  await scrapers.init();
  pushStore = scrapers;
  onHealth = (e) => {
    const sent =
      e.status === "down"
        ? scrapers.notify({
            type: e.reason === "budget" ? "budget" : "provider",
            level: e.reason === "budget" ? "warn" : "bad",
            title: `المصدر ${e.provider}: ${REASONS[e.reason]}`,
            body: `${e.message}\nتنتقل المهام للمصدر التالي، وتُعاد المحاولة بعد 15 دقيقة.`,
            url: "/settings",
            key: `provider-down:${e.provider}`,
          })
        : scrapers.notify({
            type: "provider",
            level: "ok",
            title: `المصدر ${e.provider} رجع يشتغل`,
            url: "/settings",
            key: `provider-up:${e.provider}`,
          });
    sent.catch(() => {});
  };

  let sheets: { request: GoogleRequest; email: string } | null = null;
  if (o.sheetsRequest)
    sheets = { request: o.sheetsRequest, email: o.sheetsEmail ?? "service-account" };
  else if (env.GOOGLE_SERVICE_ACCOUNT_JSON)
    sheets = serviceAccountRequest(env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const owner = env.OWNER_EMAIL || "owner";

  const runtime: Runtime = {
    scrapers,
    owner,
    sheetsEmail: sheets?.email ?? null,

    async exportLeads(req) {
      const project = await scrapers.getProject(req.projectId);
      if (!project) throw new Error(`Project not found: ${req.projectId}`);
      const rows = await scrapers.listLeads({
        ...req.filters,
        projectId: req.projectId,
        ...(req.jobId ? { jobId: req.jobId } : {}),
        limit: 5000,
      });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const base = `scrapers-${project.name}-${stamp}`.replace(/[^\p{L}\p{N}._-]+/gu, "-");

      if (req.format === "csv") {
        return {
          kind: "file",
          filename: `${base}.csv`,
          contentType: "text/csv; charset=utf-8",
          data: Buffer.from(toCsv(rows), "utf8"),
          count: rows.length,
        };
      }
      if (req.format === "xlsx") {
        return {
          kind: "file",
          filename: `${base}.xlsx`,
          contentType: XLSX_TYPE,
          data: await toXlsx(rows, { sheetName: project.name }),
          count: rows.length,
        };
      }
      if (!sheets)
        throw new Error("Google Sheets is not configured: set GOOGLE_SERVICE_ACCOUNT_JSON");
      const spreadsheetId = req.spreadsheetId ?? project.sheetId ?? undefined;
      const mode: SheetMode = req.sheetMode ?? (spreadsheetId ? "append" : "new-file");
      const result = await exportToSheet(rows, {
        request: sheets.request,
        mode,
        ...(spreadsheetId ? { spreadsheetId } : {}),
        title:
          mode === "new-file"
            ? `Scrapers – ${project.name} – ${stamp}`
            : mode === "new-tab"
              ? `${project.name} ${stamp}`
              : "Scrapers",
        ...(owner.includes("@") ? { shareWith: owner } : {}),
      });
      return { kind: "sheet", count: rows.length, ...result };
    },

    telegram,
    vapidPublicKey: push ? (env.VAPID_PUBLIC_KEY ?? null) : null,

    async healthCheck() {
      const results: { provider: string; ok: boolean; detail: string }[] = [];
      const canary = env.CANARY_USERNAME || "instagram";
      for (const p of providers) {
        if (p instanceof ApifyProvider) {
          // Checking the credit is free; fetching a profile would spend it.
          try {
            const left = await p.remainingBudgetUsd();
            results.push({
              provider: p.id,
              ok: left > 0.5,
              detail: `$${left.toFixed(2)} remaining this month`,
            });
            if (left <= 0.5) {
              await scrapers.notify({
                type: "budget",
                level: "warn",
                title: "رصيد Apify قارب على النفاد",
                body: `المتبقي هذا الشهر ≈ $${left.toFixed(2)}`,
                url: "/settings",
                key: "apify-budget-low",
              });
            }
          } catch (err) {
            results.push({ provider: p.id, ok: false, detail: (err as Error).message });
          }
          continue;
        }
        try {
          await p.getProfile(canary);
          results.push({ provider: p.id, ok: true, detail: `@${canary} fetched` });
        } catch (err) {
          results.push({ provider: p.id, ok: false, detail: (err as Error).message });
          await scrapers.notify({
            type: "provider",
            level: "bad",
            title: `الفحص اليومي: المصدر ${p.id} لا يعمل`,
            body: (err as Error).message,
            url: "/settings",
            key: `canary:${p.id}`,
          });
        }
      }
      return results;
    },

    async close() {
      if (ownBoss) await boss.stop({ graceful: true, timeout: 10_000 });
      if (ownDb) await ownDb.$client.end();
      await o.onClose?.();
    },
  };
  return runtime;
}
