import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { confirm, isCancel } from "@clack/prompts";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  type LeadFilters,
  type LeadRow,
  parseSource,
  parseUsernameCsv,
  type Source,
  type SuppressionKind,
  uploadSource,
} from "@scrapers/core";
import { buildMcpServer } from "@scrapers/mcp";
import type { ExportRequest } from "@scrapers/runtime";
import { generateVapidKeys } from "@scrapers/runtime";
import { Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";
import type { Context, ContextFactory } from "./context.js";

export interface Io {
  log(msg: string): void;
  error(msg: string): void;
  /** Asks a yes/no question; non-interactive runs get `false`. */
  confirm(msg: string): Promise<boolean>;
}

export const consoleIo: Io = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
  async confirm(message) {
    if (!process.stdin.isTTY) return false;
    const answer = await confirm({ message });
    return !isCancel(answer) && answer === true;
  },
};

const int = (name: string) => (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0)
    throw new InvalidArgumentError(`${name} must be a whole number`);
  return n;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENDED = ["done", "failed", "cancelled"];

async function resolveProject(ctx: Context, ref: string): Promise<string> {
  const all = await ctx.scrapers.listProjects();
  const p = UUID_RE.test(ref) ? all.find((x) => x.id === ref) : all.find((x) => x.name === ref);
  if (!p) throw new Error(`Project not found: ${ref} (see: scrapers project list)`);
  return p.id;
}

function sourceFrom(input: string, type: string | undefined, limit: number): Source {
  if (type === "upload" || (/\.csv$/i.test(input) && existsSync(input))) {
    const usernames = parseUsernameCsv(readFileSync(input, "utf8"), limit);
    if (usernames.length === 0) throw new Error(`No valid usernames found in ${input}`);
    return uploadSource(usernames, input);
  }
  return parseSource(input, type as "profile" | "post" | "hashtag" | undefined);
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

function formatJob(j: Awaited<ReturnType<Context["scrapers"]["getJob"]>>): string {
  const c = j.counts;
  const color = j.status === "done" ? pc.green : j.status === "failed" ? pc.red : pc.yellow;
  return [
    `${pc.bold(j.id)}  ${color(j.status)}  ${pct(j.progress)}`,
    `  ${j.sourceType} ${j.sourceUrl}${j.provider ? `  via ${j.provider}` : ""}`,
    `  discovered ${c.discovered ?? 0} · enriched ${c.enriched ?? 0} · with contact ${c.leads ?? 0} · skipped ${c.skipped ?? 0} · failed ${c.failed ?? 0}`,
    ...(j.error ? [pc.red(`  ${j.error}`)] : []),
  ].join("\n");
}

function formatLeads(rows: LeadRow[]): string {
  if (rows.length === 0) return "No leads.";
  const head = ["username", "followers", "email", "phone", "source", "score"];
  const body = rows.map((r) => [
    `@${r.username}`,
    String(r.followers ?? ""),
    r.email ?? "",
    r.phone ? `${r.phone}${r.phoneConfirmed ? "" : " (?)"}` : "",
    r.contactSource ?? "",
    r.aiScore === null ? "" : String(r.aiScore),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  return [pc.bold(line(head)), ...body.map(line)].join("\n");
}

function filterOptions(cmd: Command) {
  return cmd
    .option("--job <id>", "only leads from this job")
    .option("--business", "business accounts only")
    .option("--has-email", "only leads with an email")
    .option("--has-phone", "only leads with a phone number")
    .option("--min-score <n>", "minimum AI score", int("min-score"))
    .addOption(new Option("--status <status>", "CRM status").choices([...STATUSES]))
    .option("-q, --search <text>", "text in username, name or bio");
}

const STATUSES = ["new", "contacted", "interested", "customer", "rejected"] as const;
type Status = (typeof STATUSES)[number];

type FilterOpts = {
  job?: string;
  business?: boolean;
  hasEmail?: boolean;
  hasPhone?: boolean;
  minScore?: number;
  status?: Status;
  search?: string;
};

function toFilters(o: FilterOpts): Omit<LeadFilters, "projectId"> {
  return {
    ...(o.job ? { jobId: o.job } : {}),
    ...(o.business ? { business: true } : {}),
    ...(o.hasEmail ? { hasEmail: true } : {}),
    ...(o.hasPhone ? { hasPhone: true } : {}),
    ...(o.minScore !== undefined ? { minScore: o.minScore } : {}),
    ...(o.status ? { status: o.status } : {}),
    ...(o.search ? { q: o.search } : {}),
  };
}

async function runExport(ctx: Context, req: ExportRequest, out: string | undefined, io: Io) {
  const r = await ctx.exportLeads(req);
  if (r.kind === "sheet") {
    const dup = r.skippedDuplicates ? `, ${r.skippedDuplicates} already there` : "";
    io.log(`${pc.green("✓")} ${r.written} leads → ${r.url} (tab ${r.tab}${dup})`);
    return;
  }
  const file = out ?? r.filename;
  writeFileSync(file, r.data);
  io.log(`${pc.green("✓")} ${r.count} leads → ${file}`);
}

export type CliProgram = Command & {
  /** Closes the database and queue connections, also after a failed command. */
  close(): Promise<void>;
};

export function buildProgram(makeContext: ContextFactory, io: Io = consoleIo): CliProgram {
  let ctx: Context | undefined;
  const context = async () => {
    ctx ??= await makeContext();
    return ctx;
  };
  const program = new Command("scrapers")
    .description("Collect leads from public Instagram data")
    .showHelpAfterError()
    .configureOutput({
      writeOut: (s) => io.log(s.trimEnd()),
      writeErr: (s) => io.error(s.trimEnd()),
    })
    .hook("postAction", async () => {
      await ctx?.close();
      ctx = undefined;
    });

  const project = program.command("project").description("manage projects");
  project
    .command("create <name>")
    .option("--retention <days>", "days to keep leads", int("retention"))
    .option("--sheet <id>", "existing Google Sheet to append to")
    .option("--criteria <text>", "AI scoring criteria")
    .action(async (name: string, o: { retention?: number; sheet?: string; criteria?: string }) => {
      const c = await context();
      const p = await c.scrapers.createProject({
        name,
        owner: c.owner,
        ...(o.retention ? { retentionDays: o.retention } : {}),
        ...(o.sheet ? { sheetId: o.sheet } : {}),
        ...(o.criteria ? { aiCriteria: o.criteria } : {}),
      });
      io.log(
        `${pc.green("✓")} project ${pc.bold(p.name)} ${p.id} (keeps leads ${p.retentionDays} days)`,
      );
    });
  project.command("list").action(async () => {
    const all = await (await context()).scrapers.listProjects();
    io.log(
      all.length
        ? all.map((p) => `${p.id}  ${pc.bold(p.name)}  ${p.retentionDays}d`).join("\n")
        : "No projects.",
    );
  });

  const startOptions = (cmd: Command) =>
    cmd
      .requiredOption("-p, --project <id|name>", "project")
      .addOption(
        new Option("-t, --type <type>", "source type").choices([
          "profile",
          "post",
          "hashtag",
          "upload",
        ]),
      )
      .option("-l, --limit <n>", "max accounts", int("limit"), 100)
      .option("-y, --yes", "accept the estimated cost without asking");

  async function start(
    input: string,
    o: { project: string; type?: string; limit: number; yes?: boolean },
  ) {
    const c = await context();
    const projectId = await resolveProject(c, o.project);
    const source = sourceFrom(input, o.type, o.limit);
    const cost = c.scrapers.estimateCost(source, o.limit);
    if (
      cost > 0 &&
      !o.yes &&
      !(await io.confirm(`Estimated cost ≈ $${cost.toFixed(2)}. Continue?`))
    ) {
      io.log("Cancelled.");
      return undefined;
    }
    const { job: j } = await c.scrapers.startJob({ projectId, source, limit: o.limit });
    io.log(
      `${pc.green("✓")} job ${pc.bold(j.id)} queued (${source.type}, limit ${j.limit}, ≈ $${cost.toFixed(2)})`,
    );
    return j.id;
  }

  const job = program.command("job").description("start and follow jobs");
  startOptions(
    job.command("start <source>").description("URL, @username, #hashtag or a .csv of usernames"),
  ).action(async (input: string, o) => {
    await start(input, o);
  });
  job
    .command("status <id>")
    .option("-w, --watch", "refresh until the job ends")
    .action(async (id: string, o: { watch?: boolean }) => {
      const c = await context();
      for (;;) {
        const j = await c.scrapers.getJob(id);
        io.log(formatJob(j));
        if (!o.watch || ENDED.includes(j.status)) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    });
  job.command("cancel <id>").action(async (id: string) => {
    io.log(formatJob(await (await context()).scrapers.cancelJob(id)));
  });

  filterOptions(
    program
      .command("leads")
      .description("list leads")
      .requiredOption("-p, --project <id|name>", "project")
      .option("-n, --limit <n>", "rows", int("limit"), 50)
      .option("--json", "print JSON"),
  ).action(async (o: FilterOpts & { project: string; limit: number; json?: boolean }) => {
    const c = await context();
    const rows = await c.scrapers.listLeads({
      projectId: await resolveProject(c, o.project),
      ...toFilters(o),
      limit: o.limit,
    });
    io.log(o.json ? JSON.stringify(rows, null, 2) : formatLeads(rows));
  });

  filterOptions(
    program
      .command("export")
      .description("export leads to CSV, XLSX or Google Sheets")
      .requiredOption("-p, --project <id|name>", "project")
      .addOption(
        new Option("-f, --format <format>").choices(["csv", "xlsx", "sheet"]).default("xlsx"),
      )
      .addOption(
        new Option("--sheet-mode <mode>", "for --format sheet").choices([
          "new-file",
          "new-tab",
          "append",
        ]),
      )
      .option("--spreadsheet <id>", "spreadsheet id (default: the project's sheet)")
      .option("-o, --out <file>", "output path"),
  ).action(
    async (
      o: FilterOpts & {
        project: string;
        format: ExportRequest["format"];
        sheetMode?: ExportRequest["sheetMode"];
        spreadsheet?: string;
        out?: string;
      },
    ) => {
      const c = await context();
      const { jobId, ...filters } = toFilters(o);
      await runExport(
        c,
        {
          projectId: await resolveProject(c, o.project),
          ...(jobId ? { jobId } : {}),
          filters,
          format: o.format,
          ...(o.sheetMode ? { sheetMode: o.sheetMode } : {}),
          ...(o.spreadsheet ? { spreadsheetId: o.spreadsheet } : {}),
        },
        o.out,
        io,
      );
    },
  );

  program
    .command("score <jobId>")
    .description("score a job's leads with AI (needs ANTHROPIC_API_KEY)")
    .requiredOption("-c, --criteria <text>", "what a good lead looks like")
    .option("--rescore", "score leads that already have a score too")
    .action(async (jobId: string, o: { criteria: string; rescore?: boolean }) => {
      const r = await (await context()).scrapers.scoreLeads(
        jobId,
        o.criteria,
        o.rescore ? { rescore: true } : {},
      );
      if (r.mode === "batch") {
        io.log(
          `${pc.green("✓")} ${r.count} leads sent as batch ${r.batchId}; results arrive within the hour (scrapers worker collects them)`,
        );
      } else io.log(`${pc.green("✓")} scored ${r.count} leads`);
    });

  program
    .command("report <jobId>")
    .description("audience report for a job")
    .action(async (jobId: string) => {
      const { stats, report } = await (await context()).scrapers.audienceReport(jobId);
      io.log(report || JSON.stringify(stats, null, 2));
    });

  const keys = program.command("keys").description("API keys for the REST API and remote MCP");
  keys
    .command("create <name>")
    .option("-s, --scopes <scopes>", "comma-separated: read,write", "read")
    .action(async (name: string, o: { scopes: string }) => {
      const scopes = o.scopes
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is "read" | "write" => s === "read" || s === "write");
      const k = await (await context()).scrapers.createApiKey(
        name,
        scopes.length ? scopes : ["read"],
      );
      io.log(
        `${pc.green("✓")} ${k.name} [${k.scopes.join(",")}]\n${pc.bold(k.key)}\n${pc.yellow("Shown once: store it now.")}`,
      );
    });
  keys.command("list").action(async () => {
    const all = await (await context()).scrapers.listApiKeys();
    io.log(
      all.length
        ? all
            .map(
              (k) =>
                `${k.id}  ${k.name}  [${k.scopes.join(",")}]  last used ${k.lastUsed?.toISOString() ?? "never"}`,
            )
            .join("\n")
        : "No keys.",
    );
  });
  keys.command("revoke <id>").action(async (id: string) => {
    await (await context()).scrapers.revokeApiKey(id);
    io.log(`${pc.green("✓")} revoked`);
  });

  const lead = program.command("lead").description("work with one lead");
  lead
    .command("status <username> <status>")
    .description(`set the CRM status: ${STATUSES.join(", ")}`)
    .requiredOption("-p, --project <id|name>", "project")
    .option("--note <text>", "note")
    .action(async (username: string, status: string, o: { project: string; note?: string }) => {
      if (!STATUSES.includes(status as Status))
        throw new InvalidArgumentError(`status must be one of ${STATUSES.join(", ")}`);
      const c = await context();
      const ok = await c.scrapers.setLeadStatus({
        projectId: await resolveProject(c, o.project),
        username,
        status: status as Status,
        ...(o.note !== undefined ? { note: o.note } : {}),
      });
      if (!ok) throw new Error(`@${username.replace(/^@/, "")} is not a lead in this project`);
      io.log(`${pc.green("✓")} @${username.replace(/^@/, "")} → ${status}`);
    });

  project
    .command("set <name>")
    .description("change project settings")
    .option(
      "--auto-export",
      "append every lead (with score) to the project sheet when a job finishes",
    )
    .option("--no-auto-export", "turn auto export off")
    .option("--keywords <list>", "comma-separated watch keywords ('' clears)")
    .option("--criteria <text>", "AI scoring criteria ('' clears)")
    .option("--sheet <id>", "Google Sheet id ('' clears)")
    .action(
      async (
        name: string,
        o: { autoExport?: boolean; keywords?: string; criteria?: string; sheet?: string },
      ) => {
        const c = await context();
        const id = await resolveProject(c, name);
        const keywords = o.keywords
          ?.split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        const p = await c.scrapers.updateProject(id, {
          ...(o.autoExport !== undefined ? { autoExport: o.autoExport } : {}),
          ...(keywords !== undefined ? { watchKeywords: keywords.length ? keywords : null } : {}),
          ...(o.criteria !== undefined ? { aiCriteria: o.criteria || null } : {}),
          ...(o.sheet !== undefined ? { sheetId: o.sheet || null } : {}),
        });
        io.log(
          `${pc.green("✓")} ${p?.name}: auto export ${p?.autoExport ? "on" : "off"} · keywords ${p?.watchKeywords?.join(", ") || "—"} · sheet ${p?.sheetId ?? "—"}`,
        );
      },
    );

  const monitor = program
    .command("monitor")
    .description("watch competitors: recurring jobs that collect only new accounts");
  monitor
    .command("add <source>")
    .requiredOption("-p, --project <id|name>", "project")
    .option("-e, --every <days>", "run every N days", int("every"), 7)
    .option("-l, --limit <n>", "max accounts per run", int("limit"), 100)
    .action(async (input: string, o: { project: string; every: number; limit: number }) => {
      const c = await context();
      const m = await c.scrapers.createMonitor({
        projectId: await resolveProject(c, o.project),
        source: parseSource(input),
        everyDays: o.every,
        limit: o.limit,
      });
      io.log(`${pc.green("✓")} monitor ${m.id} · ${m.sourceUrl} every ${m.everyDays} days`);
    });
  monitor
    .command("list")
    .option("-p, --project <id|name>", "project")
    .action(async (o: { project?: string }) => {
      const c = await context();
      const all = await c.scrapers.listMonitors(
        o.project ? await resolveProject(c, o.project) : undefined,
      );
      io.log(
        all.length
          ? all
              .map(
                (m) =>
                  `${m.id}  ${m.enabled ? pc.green("on ") : pc.dim("off")}  every ${m.everyDays}d  ${m.sourceUrl}  last ${m.lastRunAt?.toISOString() ?? "never"}`,
              )
              .join("\n")
          : "No monitors.",
      );
    });
  monitor.command("rm <id>").action(async (id: string) => {
    await (await context()).scrapers.deleteMonitor(id);
    io.log(`${pc.green("✓")} removed`);
  });
  monitor
    .command("run")
    .description("start every monitor that is due (the daily cron does this)")
    .action(async () => {
      const ids = await (await context()).scrapers.runDueMonitors();
      io.log(
        ids.length
          ? `${pc.green("✓")} started ${ids.length} job(s): ${ids.join(", ")}`
          : "No monitor is due.",
      );
    });

  program
    .command("push-keys")
    .description("generate VAPID keys for browser push notifications")
    .action(() => {
      const k = generateVapidKeys();
      io.log(
        `VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\n${pc.yellow("Put both in your environment; keep the private key secret.")}`,
      );
    });

  program
    .command("doctor")
    .description("check configuration, database and data sources")
    .option("--live", "also fetch one public profile from each free provider")
    .action(async (o: { live?: boolean }) => {
      const env = process.env;
      const line = (ok: boolean | null, label: string, detail = "") =>
        io.log(
          `${ok === null ? pc.dim("–") : ok ? pc.green("✓") : pc.red("✗")} ${label}${detail ? pc.dim(`  ${detail}`) : ""}`,
        );
      line(!!(env.DATABASE_URL || env.POSTGRES_URL), "DATABASE_URL");
      line(!!env.SUPPRESSION_PEPPER, "SUPPRESSION_PEPPER");
      line(
        !!(env.WORKER_URL || env.APIFY_TOKEN || env.IG_GRAPH_TOKEN),
        "at least one data source",
        "WORKER_URL / APIFY_TOKEN / IG_GRAPH_TOKEN",
      );
      line(
        env.ANTHROPIC_API_KEY ? true : null,
        "AI scoring",
        env.ANTHROPIC_API_KEY ? "" : "optional",
      );
      line(
        env.GOOGLE_SERVICE_ACCOUNT_JSON ? true : null,
        "Google Sheets",
        env.GOOGLE_SERVICE_ACCOUNT_JSON ? "" : "optional",
      );
      line(
        env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? true : null,
        "Telegram",
        env.TELEGRAM_BOT_TOKEN ? "" : "optional",
      );
      line(
        env.VAPID_PUBLIC_KEY ? true : null,
        "browser push",
        env.VAPID_PUBLIC_KEY ? "" : "optional (scrapers push-keys)",
      );
      const c = await context();
      const h = await c.scrapers.systemHealth();
      line(
        true,
        "database reachable",
        `${(h.dbBytes / 1024 / 1024).toFixed(1)}MB · ${h.leads} leads · ${h.jobs} jobs`,
      );
      if (o.live) {
        for (const r of await c.healthCheck()) line(r.ok, `provider ${r.provider}`, r.detail);
      } else {
        line(null, "providers", "run with --live to test them (Apify only checks the credit)");
      }
    });

  program
    .command("suppress")
    .description("never collect this person again and delete their data")
    .option("--username <u>")
    .option("--email <e>")
    .option("--phone <p>")
    .option("--reason <text>")
    .action(async (o: { username?: string; email?: string; phone?: string; reason?: string }) => {
      const entries = (["username", "email", "phone"] as SuppressionKind[]).flatMap((k) =>
        o[k] ? [[k, o[k]] as const] : [],
      );
      if (entries.length === 0)
        throw new InvalidArgumentError("give --username, --email or --phone");
      const c = await context();
      for (const [kind, value] of entries) await c.scrapers.suppress(kind, value, o.reason);
      io.log(`${pc.green("✓")} suppressed ${entries.map(([k]) => k).join(", ")}`);
    });

  program
    .command("worker")
    .description("process queued jobs until stopped (Ctrl+C)")
    .action(async () => {
      const c = await context();
      await c.scrapers.work();
      io.log("Worker running. Press Ctrl+C to stop.");
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    });

  program
    .command("mcp")
    .description(
      "serve the MCP tools over stdio (Claude Desktop / Claude Code); jobs run in this process",
    )
    .action(async () => {
      const c = await context();
      await c.scrapers.work();
      // stdout belongs to the MCP protocol: nothing else may print to it.
      const handle = serveStdio(() => buildMcpServer(c));
      await new Promise<void>((resolve) => {
        process.stdin.once("end", resolve);
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      await handle.close();
    });

  startOptions(
    program
      .command("run <source>")
      .description("start a job, process it here and optionally export when done")
      .addOption(
        new Option("-f, --format <format>", "export when done").choices(["csv", "xlsx", "sheet"]),
      )
      .option("-o, --out <file>", "output path")
      .option("--poll <seconds>", "queue polling interval", "2"),
  ).action(
    async (
      input: string,
      o: {
        project: string;
        type?: string;
        limit: number;
        yes?: boolean;
        format?: ExportRequest["format"];
        out?: string;
        poll: string;
      },
    ) => {
      const id = await start(input, o);
      if (!id) return;
      const c = await context();
      await c.scrapers.work({ pollingIntervalSeconds: Number(o.poll) });
      let last = "";
      for (;;) {
        const j = await c.scrapers.getJob(id);
        const line = `${j.status} ${pct(j.progress)}`;
        if (line !== last) io.log(`  ${line}`);
        last = line;
        if (ENDED.includes(j.status)) {
          io.log(formatJob(j));
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (o.format)
        await runExport(
          c,
          { projectId: await resolveProject(c, o.project), jobId: id, format: o.format },
          o.out,
          io,
        );
    },
  );

  return Object.assign(program, {
    async close() {
      await ctx?.close();
      ctx = undefined;
    },
  });
}
