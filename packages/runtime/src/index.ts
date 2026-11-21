import { AnthropicScorer } from "@scrapers/ai";
import {
  createScrapers,
  type LeadFilters,
  type Provider,
  ProviderRouter,
  type Scorer,
  type Scrapers,
} from "@scrapers/core";
import { type AnyDb, createDb } from "@scrapers/db";
import {
  exportToSheet,
  type GoogleRequest,
  type SheetExportResult,
  type SheetMode,
  serviceAccountRequest,
  toCsv,
  toXlsx,
} from "@scrapers/exporters";
import { providersFromEnv } from "@scrapers/providers";
import { PgBoss } from "pg-boss";

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
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
    ownDb = createDb(env.DATABASE_URL, o.serverless ? { max: 3 } : {});
    db = ownDb;
  }

  let boss = o.boss;
  const ownBoss = !boss;
  if (!boss) {
    // pg-boss needs a session connection: Supabase's session pooler or direct URL, not the transaction pooler.
    boss = new PgBoss({
      connectionString: env.DIRECT_DATABASE_URL ?? env.DATABASE_URL ?? "",
      ...(o.serverless ? { supervise: false, schedule: false, max: 3 } : {}),
    });
    boss.on("error", (err) => console.error("[pg-boss]", err.message));
    await boss.start();
  }

  const scorer =
    o.scorer === null
      ? undefined
      : (o.scorer ?? (env.ANTHROPIC_API_KEY ? new AnthropicScorer() : undefined));

  const scrapers = createScrapers({
    db,
    boss,
    router: new ProviderRouter(o.providers ?? providersFromEnv(env)),
    scorer,
    config: {
      suppressionPepper: env.SUPPRESSION_PEPPER,
      maxJobLimit: Number(env.MAX_JOB_LIMIT ?? 1000),
      defaultRetentionDays: Number(env.DEFAULT_RETENTION_DAYS ?? 90),
    },
  });
  await scrapers.init();

  let sheets: { request: GoogleRequest; email: string } | null = null;
  if (o.sheetsRequest)
    sheets = { request: o.sheetsRequest, email: o.sheetsEmail ?? "service-account" };
  else if (env.GOOGLE_SERVICE_ACCOUNT_JSON)
    sheets = serviceAccountRequest(env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const owner = env.OWNER_EMAIL || "owner";

  return {
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

    async close() {
      if (ownBoss) await boss.stop({ graceful: true, timeout: 10_000 });
      if (ownDb) await ownDb.$client.end();
      await o.onClose?.();
    },
  };
}
