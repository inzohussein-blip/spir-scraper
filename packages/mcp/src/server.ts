import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { parseSource, type Source, SourceError, uploadSource } from "@scrapers/core";
import type { Runtime } from "@scrapers/runtime";
import { z } from "zod";

export interface McpOptions {
  /** Called after a job is queued, e.g. to process it on a serverless host. */
  onJobStarted?: (jobId: string) => void;
  /** Hard cap on accounts per job requested over MCP. */
  maxLimit?: number;
}

const STATUSES = ["new", "contacted", "interested", "customer", "rejected"] as const;

const COMPLIANCE =
  "Collects public Instagram data only. Contact details are kept for business, verified and influencer accounts. " +
  "Unsolicited outreach about financial products may break regulator rules and broker terms; this server never sends messages.";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const json = (value: object): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

async function projectIdFor(rt: Runtime, ref: string): Promise<string> {
  const all = await rt.scrapers.listProjects();
  const p = all.find((x) => x.id === ref) ?? all.find((x) => x.name === ref);
  if (p) return p.id;
  // Creating projects by name keeps Claude-driven work to one step.
  return (await rt.scrapers.createProject({ name: ref, owner: rt.owner })).id;
}

/** Builds one MCP server instance over a runtime. Register once, serve over stdio or HTTP. */
export function buildMcpServer(rt: Runtime, opts: McpOptions = {}): McpServer {
  const maxLimit = opts.maxLimit ?? 1000;
  const server = new McpServer(
    { name: "scrapers", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: COMPLIANCE },
  );

  const guard =
    <A>(fn: (args: A) => Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return await fn(args);
      } catch (err) {
        return fail(err instanceof SourceError ? err.message : `Error: ${(err as Error).message}`);
      }
    };

  server.registerTool(
    "start_job",
    {
      title: "Start a collection job",
      description:
        "Queue a job that collects public accounts related to an Instagram profile, post or hashtag, " +
        "or a list of usernames. Returns immediately with a job_id; follow progress with get_job. " +
        `Profile/post/hashtag sources need the Apify provider; a usernames list always works. ${COMPLIANCE}`,
      inputSchema: z.object({
        source: z.string().optional().describe("Instagram URL, @username or #hashtag"),
        usernames: z
          .array(z.string())
          .optional()
          .describe("Explicit usernames to look up instead of a source"),
        source_type: z.enum(["profile", "post", "hashtag"]).optional(),
        limit: z.number().int().min(1).max(maxLimit).default(100),
        project: z.string().describe("Project name or id; created if it does not exist"),
      }),
    },
    guard(async (a) => {
      let source: Source;
      if (a.usernames?.length) {
        source = uploadSource(
          a.usernames.map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(Boolean),
          "mcp:usernames",
        );
      } else if (a.source) {
        source = parseSource(a.source, a.source_type);
      } else {
        return fail("Give either source or usernames");
      }
      const projectId = await projectIdFor(rt, a.project);
      const { job, estimatedCostUsd } = await rt.scrapers.startJob({
        projectId,
        source,
        limit: a.limit,
      });
      opts.onJobStarted?.(job.id);
      return json({
        job_id: job.id,
        project_id: projectId,
        status: job.status,
        limit: job.limit,
        estimated_cost_usd: estimatedCostUsd,
      });
    }),
  );

  server.registerTool(
    "get_job",
    {
      title: "Job status",
      description: "Status, counts and progress (0-1) of a job.",
      inputSchema: z.object({ job_id: z.string().uuid() }),
      annotations: { readOnlyHint: true },
    },
    guard(async ({ job_id }) => {
      const j = await rt.scrapers.getJob(job_id);
      return json({
        job_id: j.id,
        status: j.status,
        progress: j.progress,
        counts: j.counts,
        provider: j.provider,
        error: j.error,
        source: j.sourceUrl,
      });
    }),
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel a job",
      description: "Stop a queued or running job.",
      inputSchema: z.object({ job_id: z.string().uuid() }),
    },
    guard(async ({ job_id }) => {
      const j = await rt.scrapers.cancelJob(job_id);
      return json({ job_id: j.id, status: j.status });
    }),
  );

  server.registerTool(
    "list_leads",
    {
      title: "List leads",
      description:
        "Page through collected leads, best AI score first. Each lead has username, followers, category, city, " +
        "email/phone when public, contact_source, AI score/tags, CRM status, engagement rate and quality flags. " +
        "Pass next_cursor back as cursor for the next page. Use this to classify leads yourself when the server has no AI key.",
      inputSchema: z.object({
        project: z.string(),
        job_id: z.string().uuid().optional(),
        business_only: z.boolean().optional(),
        has_email: z.boolean().optional(),
        has_phone: z.boolean().optional(),
        min_score: z.number().int().min(0).max(100).optional(),
        status: z.enum(STATUSES).optional(),
        search: z.string().max(100).optional().describe("Text in username, name or bio"),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const projectId = await projectIdFor(rt, a.project);
      const page = await rt.scrapers.listLeadsPage({
        projectId,
        ...(a.job_id ? { jobId: a.job_id } : {}),
        ...(a.business_only ? { business: true } : {}),
        ...(a.has_email ? { hasEmail: true } : {}),
        ...(a.has_phone ? { hasPhone: true } : {}),
        ...(a.min_score !== undefined ? { minScore: a.min_score } : {}),
        ...(a.status ? { status: a.status } : {}),
        ...(a.search ? { q: a.search } : {}),
        ...(a.cursor ? { cursor: a.cursor } : {}),
        limit: a.limit,
      });
      return json({ count: page.leads.length, next_cursor: page.nextCursor, leads: page.leads });
    }),
  );

  server.registerTool(
    "get_profile",
    {
      title: "Stored profile",
      description: "One stored public profile with the jobs it was collected from.",
      inputSchema: z.object({ username: z.string() }),
      annotations: { readOnlyHint: true },
    },
    guard(async ({ username }) => {
      const p = await rt.scrapers.getStoredProfile(username);
      return p ? json(p) : fail(`@${username} has not been collected`);
    }),
  );

  server.registerTool(
    "score_leads",
    {
      title: "Score leads with AI",
      description:
        "Classify and score a job's leads 0-100 against free-text criteria using the server's AI key. " +
        "Large jobs are scored as a batch and finish later. Without a server AI key, read list_leads and score them yourself.",
      inputSchema: z.object({
        job_id: z.string().uuid(),
        criteria: z.string().min(3).describe("What a good lead looks like, in any language"),
        rescore: z.boolean().optional(),
      }),
    },
    guard(async ({ job_id, criteria, rescore }) => {
      if (!rt.scrapers.scoringAvailable) {
        return fail(
          "This server has no ANTHROPIC_API_KEY. Use list_leads and score the leads yourself.",
        );
      }
      return json(await rt.scrapers.scoreLeads(job_id, criteria, rescore ? { rescore } : {}));
    }),
  );

  server.registerTool(
    "export_leads",
    {
      title: "Export leads",
      description:
        "Export leads to Google Sheets (a new spreadsheet, a new tab, or appended to the project's sheet). " +
        "For CSV/XLSX files use the dashboard or CLI.",
      inputSchema: z.object({
        project: z.string(),
        job_id: z.string().uuid().optional(),
        mode: z.enum(["new-file", "new-tab", "append"]).optional(),
        spreadsheet_id: z.string().optional(),
        business_only: z.boolean().optional(),
        has_phone: z.boolean().optional(),
        has_email: z.boolean().optional(),
        min_score: z.number().int().min(0).max(100).optional(),
      }),
    },
    guard(async (a) => {
      const projectId = await projectIdFor(rt, a.project);
      const r = await rt.exportLeads({
        projectId,
        format: "sheet",
        ...(a.job_id ? { jobId: a.job_id } : {}),
        ...(a.mode ? { sheetMode: a.mode } : {}),
        ...(a.spreadsheet_id ? { spreadsheetId: a.spreadsheet_id } : {}),
        filters: {
          ...(a.business_only ? { business: true } : {}),
          ...(a.has_phone ? { hasPhone: true } : {}),
          ...(a.has_email ? { hasEmail: true } : {}),
          ...(a.min_score !== undefined ? { minScore: a.min_score } : {}),
        },
      });
      return json(r);
    }),
  );

  server.registerTool(
    "suppress",
    {
      title: "Suppress a person",
      description:
        "Never collect this username, email or phone again, and delete existing data for it.",
      inputSchema: z.object({
        kind: z.enum(["username", "email", "phone"]),
        value: z.string().min(1),
        reason: z.string().optional(),
      }),
      annotations: { destructiveHint: true },
    },
    guard(async ({ kind, value, reason }) => {
      await rt.scrapers.suppress(kind, value, reason);
      return json({ suppressed: kind });
    }),
  );

  server.registerTool(
    "set_lead_status",
    {
      title: "Set a lead's status",
      description:
        "Record where the owner is with a lead: new, contacted, interested, customer or rejected, with an optional note. " +
        "Kept when the account is collected again.",
      inputSchema: z.object({
        project: z.string(),
        username: z.string(),
        status: z.enum(STATUSES),
        note: z.string().max(500).optional(),
      }),
    },
    guard(async (a) => {
      const projectId = await projectIdFor(rt, a.project);
      const updated = await rt.scrapers.setLeadStatus({
        projectId,
        username: a.username,
        status: a.status,
        ...(a.note !== undefined ? { note: a.note } : {}),
      });
      return updated
        ? json({ updated: true })
        : fail(`@${a.username} is not a lead in this project`);
    }),
  );

  server.registerTool(
    "update_project",
    {
      title: "Project settings",
      description:
        "Change a project's settings: auto_export appends every lead (with score and status) to the project's Google Sheet " +
        "when a job finishes; ai_criteria makes finished jobs get scored automatically; watch_keywords alerts the owner " +
        "when a collected name or bio contains one of them.",
      inputSchema: z.object({
        project: z.string(),
        auto_export: z.boolean().optional(),
        ai_criteria: z.string().max(2000).nullable().optional(),
        watch_keywords: z.array(z.string().max(50)).max(50).nullable().optional(),
        sheet_id: z.string().nullable().optional(),
      }),
    },
    guard(async (a) => {
      const projectId = await projectIdFor(rt, a.project);
      const p = await rt.scrapers.updateProject(projectId, {
        autoExport: a.auto_export,
        aiCriteria: a.ai_criteria,
        watchKeywords: a.watch_keywords,
        sheetId: a.sheet_id,
      });
      return p ? json(p) : fail("Project not found");
    }),
  );

  server.registerTool(
    "watch_competitor",
    {
      title: "Watch a competitor",
      description:
        "Create a recurring job for a competitor profile, post or hashtag that collects only accounts the project does not " +
        "have yet. It runs with the daily background task.",
      inputSchema: z.object({
        project: z.string(),
        source: z.string(),
        every_days: z.number().int().min(1).max(90).default(7),
        limit: z.number().int().min(1).max(maxLimit).default(100),
      }),
    },
    guard(async (a) => {
      const projectId = await projectIdFor(rt, a.project);
      const m = await rt.scrapers.createMonitor({
        projectId,
        source: parseSource(a.source),
        everyDays: a.every_days,
        limit: a.limit,
      });
      return json({ monitor_id: m.id, source: m.sourceUrl, every_days: m.everyDays });
    }),
  );

  server.registerTool(
    "list_monitors",
    {
      title: "Competitor monitors",
      description: "List competitor monitors with their schedule and last run.",
      inputSchema: z.object({ project: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const projectId = a.project ? await projectIdFor(rt, a.project) : undefined;
      return json({ monitors: await rt.scrapers.listMonitors(projectId) });
    }),
  );

  server.registerResource(
    "projects",
    "projects://list",
    { title: "Projects", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await rt.scrapers.listProjects()),
        },
      ],
    }),
  );

  server.registerResource(
    "latest-leads",
    new ResourceTemplate("leads://{project}/latest", { list: undefined }),
    { title: "Latest leads of a project", mimeType: "application/json" },
    async (uri, vars) => {
      const projectId = await projectIdFor(rt, decodeURIComponent(String(vars.project)));
      const leads = await rt.scrapers.listLeads({ projectId, limit: 100 });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(leads) }],
      };
    },
  );

  server.registerResource(
    "job-summary",
    new ResourceTemplate("jobs://{id}/summary", { list: undefined }),
    { title: "Job summary", mimeType: "application/json" },
    async (uri, vars) => {
      const job = await rt.scrapers.getJob(String(vars.id));
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(job) }],
      };
    },
  );

  server.registerPrompt(
    "find_partners",
    {
      title: "Find partner accounts",
      description:
        "Collect accounts around a competitor, rank them for a partnership and put the best in a sheet.",
      argsSchema: z.object({
        source: z.string().describe("Competitor profile, post or hashtag"),
        project: z.string(),
        criteria: z.string().describe("What a good partner looks like"),
        top: z.string().optional().describe("How many to export (default 50)"),
      }),
    },
    ({ source, project, criteria, top }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Use the scrapers tools. 1) start_job with source "${source}" in project "${project}". ` +
              "2) Poll get_job every few seconds until it is done. " +
              `3) Score the leads against: "${criteria}" — with score_leads if available, otherwise read list_leads and judge them yourself. ` +
              `4) export_leads the best ${top ?? "50"} business accounts to Google Sheets and give me the link with a short summary.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "audience_report",
    {
      title: "Audience report",
      description:
        "Summarise who a job collected: segments, languages, countries and the strongest accounts.",
      argsSchema: z.object({ project: z.string(), job_id: z.string() }),
    },
    ({ project, job_id }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Read list_leads for project "${project}" and job ${job_id} (page through all of it). ` +
              "Write a short Arabic report: segment split, languages and countries, the 10 strongest accounts and why, and three content ideas. Use only the data.",
          },
        },
      ],
    }),
  );

  return server;
}
