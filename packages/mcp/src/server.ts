import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { checkMessage, parseSource, type Source, SourceError, uploadSource } from "@scrapers/core";
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
        "source_type 'profile' collects people who comment on the account's recent posts; " +
        "'followers' collects the account's followers list (Instagram may expose only part of it). " +
        `Profile/followers/post/hashtag sources need the Apify provider; a usernames list always works. ${COMPLIANCE}`,
      inputSchema: z.object({
        source: z.string().optional().describe("Instagram URL, @username or #hashtag"),
        usernames: z
          .array(z.string())
          .optional()
          .describe("Explicit usernames to look up instead of a source"),
        source_type: z.enum(["profile", "followers", "post", "hashtag"]).optional(),
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
        "Page through collected leads, best AI score first. Each lead has username, followers, category, city, country, language, " +
        "sources (the competitors or posts it was found in; several means stronger interest), " +
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
        country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2, e.g. KW"),
        language: z.string().length(2).optional().describe("ISO 639-1 of the bio, e.g. ar"),
        min_sources: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Found in at least this many competitors' audiences or posts"),
        min_followers: z.number().int().min(0).optional(),
        max_followers: z.number().int().min(0).optional(),
        persona: z.string().optional().describe("Audience segment name (see build_personas)"),
        signal: z
          .enum(["rising", "became_business"])
          .optional()
          .describe("rising: grew 20%+ over 2+ weeks while 1k-200k followers"),
        platform: z
          .enum([
            "tiktok",
            "youtube",
            "telegram",
            "x",
            "facebook",
            "linkedin",
            "snapchat",
            "threads",
            "website",
          ])
          .optional()
          .describe("Only leads with an account on this other platform"),
        terms: z
          .array(z.string())
          .max(20)
          .optional()
          .describe(
            "Words with one meaning, in Arabic and English; a lead matches any (search by meaning)",
          ),
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
        ...(a.country ? { country: a.country } : {}),
        ...(a.language ? { language: a.language } : {}),
        ...(a.min_sources ? { minSources: a.min_sources } : {}),
        ...(a.min_followers !== undefined ? { minFollowers: a.min_followers } : {}),
        ...(a.max_followers !== undefined ? { maxFollowers: a.max_followers } : {}),
        ...(a.persona ? { persona: a.persona } : {}),
        ...(a.signal ? { signal: a.signal } : {}),
        ...(a.terms?.length ? { terms: a.terms } : {}),
        ...(a.platform ? { platform: a.platform } : {}),
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
        "follow_up_at (ISO date) sets a reminder the owner receives on that day; null clears it. " +
        "Kept when the account is collected again.",
      inputSchema: z.object({
        project: z.string(),
        username: z.string(),
        status: z.enum(STATUSES),
        note: z.string().max(500).optional(),
        follow_up_at: z.iso.datetime({ offset: true }).or(z.iso.date()).nullable().optional(),
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
      if (updated && a.follow_up_at !== undefined)
        await rt.scrapers.setFollowUp({
          projectId,
          username: a.username,
          at: a.follow_up_at === null ? null : new Date(a.follow_up_at),
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
        skip_fake: z
          .boolean()
          .optional()
          .describe("Do not keep accounts with two or more fake signals and no contact"),
        message_template: z.string().max(1000).nullable().optional(),
      }),
    },
    guard(async (a) => {
      const projectId = await projectIdFor(rt, a.project);
      const p = await rt.scrapers.updateProject(projectId, {
        autoExport: a.auto_export,
        aiCriteria: a.ai_criteria,
        watchKeywords: a.watch_keywords,
        sheetId: a.sheet_id,
        skipFake: a.skip_fake,
        messageTemplate: a.message_template,
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
    "lead_detail",
    {
      title: "A lead with its history",
      description:
        "One lead with its bio, contacts, score, the sources it was found in, and its history: the owner's notes, " +
        "status changes, follow-up dates and profile changes (new email, new number, became a business).",
      inputSchema: z.object({ project: z.string(), username: z.string() }),
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const d = await rt.scrapers.leadDetail(await projectIdFor(rt, a.project), a.username);
      return d ? json(d) : fail(`@${a.username} is not a lead in this project`);
    }),
  );

  server.registerTool(
    "add_lead_note",
    {
      title: "Add a note to a lead",
      description:
        "Add a note to a lead's history, e.g. what was said on a call and the next step.",
      inputSchema: z.object({
        project: z.string(),
        username: z.string(),
        text: z.string().min(1).max(2000),
      }),
    },
    guard(async (a) => {
      const ok = await rt.scrapers.addLeadNote({
        projectId: await projectIdFor(rt, a.project),
        username: a.username,
        text: a.text,
      });
      return ok ? json({ added: true }) : fail(`@${a.username} is not a lead in this project`);
    }),
  );

  server.registerTool(
    "bulk_update_leads",
    {
      title: "Change many leads",
      description:
        "Set the status and/or a follow-up date (ISO date, null clears it) for up to 500 leads at once.",
      inputSchema: z.object({
        project: z.string(),
        usernames: z.array(z.string()).min(1).max(500),
        status: z.enum(STATUSES).optional(),
        follow_up_at: z.iso.datetime({ offset: true }).or(z.iso.date()).nullable().optional(),
      }),
    },
    guard(async (a) => {
      const n = await rt.scrapers.bulkUpdateLeads({
        projectId: await projectIdFor(rt, a.project),
        usernames: a.usernames,
        ...(a.status ? { status: a.status } : {}),
        ...(a.follow_up_at !== undefined
          ? { followUpAt: a.follow_up_at === null ? null : new Date(a.follow_up_at) }
          : {}),
      });
      return json({ updated: n });
    }),
  );

  server.registerTool(
    "analyze_competitor",
    {
      title: "Analyse a competitor",
      description:
        "Read a competitor's public profile and recent posts (one provider call): engagement, which content type works " +
        "best, best posting days and hours, top hashtags and posts, follower growth since the last look, and (with a server " +
        "AI key) a short Arabic brief with content ideas. Without the brief, write your own from the numbers.",
      inputSchema: z.object({
        username: z.string(),
        project: z.string().optional().describe("Its AI criteria set the goal of the brief"),
      }),
    },
    guard(async (a) => {
      const projectId = a.project ? await projectIdFor(rt, a.project) : undefined;
      return json(
        await rt.scrapers.analyzeCompetitor({
          username: a.username,
          ...(projectId ? { projectId } : {}),
        }),
      );
    }),
  );

  server.registerTool(
    "set_deal",
    {
      title: "Record a closed deal",
      description:
        "Record what a closed deal was worth (deposit, commission... in USD). The lead becomes a customer and the value " +
        "is credited to the sources that found it (see source_performance). value null clears the deal.",
      inputSchema: z.object({
        project: z.string(),
        username: z.string(),
        value: z.number().min(0).nullable(),
      }),
    },
    guard(async (a) => {
      const ok = await rt.scrapers.setDeal({
        projectId: await projectIdFor(rt, a.project),
        username: a.username,
        value: a.value,
      });
      return ok ? json({ recorded: true }) : fail(`@${a.username} is not a lead in this project`);
    }),
  );

  server.registerTool(
    "similar_leads",
    {
      title: "Find look-alikes",
      description:
        "Accounts in the project whose name, category and bio read most like the given one (trigram similarity). " +
        "Use it on the owner's best customers to find more like them.",
      inputSchema: z.object({
        project: z.string(),
        username: z.string(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (a) =>
      json({
        similar: await rt.scrapers.similarLeads(
          await projectIdFor(rt, a.project),
          a.username,
          a.limit,
        ),
      }),
    ),
  );

  server.registerTool(
    "build_personas",
    {
      title: "Find audience segments",
      description:
        "With the server's AI key: read a sample of the project's bios, find 3-8 audience segments with the words " +
        "that mark them, save them, and assign every lead. Then list_leads(persona=...) and persona revenue in " +
        "source_performance's sibling report on the dashboard.",
      inputSchema: z.object({ project: z.string() }),
    },
    guard(async (a) => {
      if (!rt.scrapers.scoringAvailable)
        return fail(
          "This server has no ANTHROPIC_API_KEY. Read list_leads and segment them yourself.",
        );
      return json(await rt.scrapers.buildPersonas(await projectIdFor(rt, a.project)));
    }),
  );

  server.registerTool(
    "search_places",
    {
      title: "Find businesses on Google Maps",
      description:
        "Search Google Maps (through Apify, about $4 per 1000 places) for businesses such as exchange offices, " +
        "brokers or trading academies in a place, and keep them in the project. Then analyze_places reads their " +
        "websites for Instagram accounts and emails, and places_to_leads turns those accounts into leads.",
      inputSchema: z.object({
        project: z.string(),
        query: z.string().min(2).max(100),
        location: z.string().min(2).max(100),
        limit: z.number().int().min(1).max(200).default(30),
      }),
    },
    guard(async (a) =>
      json(
        await rt.scrapers.searchPlaces({
          projectId: await projectIdFor(rt, a.project),
          query: a.query,
          location: a.location,
          limit: a.limit,
        }),
      ),
    ),
  );

  server.registerTool(
    "list_places",
    {
      title: "Businesses found",
      description:
        "The project's Google Maps businesses with phone, website, rating, Instagram and emails found.",
      inputSchema: z.object({
        project: z.string(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (a) =>
      json({
        places: await rt.scrapers.listPlaces(await projectIdFor(rt, a.project), { limit: a.limit }),
      }),
    ),
  );

  server.registerTool(
    "analyze_places",
    {
      title: "Read businesses' websites",
      description:
        "Read up to 20 businesses' websites (not read yet) for their Instagram account and emails.",
      inputSchema: z.object({ project: z.string() }),
    },
    guard(async (a) =>
      json(await rt.scrapers.analyzePlaces(await projectIdFor(rt, a.project), 20)),
    ),
  );

  server.registerTool(
    "places_to_leads",
    {
      title: "Turn businesses into leads",
      description:
        "Start a job for the Instagram accounts found on businesses' websites, so they become leads.",
      inputSchema: z.object({ project: z.string() }),
    },
    guard(async (a) => {
      const r = await rt.scrapers.placesToLeads(await projectIdFor(rt, a.project));
      if (r.jobId) opts.onJobStarted?.(r.jobId);
      return json(r);
    }),
  );

  server.registerTool(
    "watch_site",
    {
      title: "Watch a competitor's page",
      description:
        "Watch a competitor's web page (prices, commissions, offers). It is read daily; when its text changes the " +
        "owner is alerted with the lines added and removed. Pass remove_id to stop watching. Lists all watches.",
      inputSchema: z.object({
        url: z.string().min(4).max(500).optional(),
        label: z.string().max(100).optional(),
        remove_id: z.string().uuid().optional(),
      }),
    },
    guard(async (a) => {
      if (a.remove_id) await rt.scrapers.removeSiteWatch(a.remove_id);
      if (a.url) {
        await rt.scrapers.addSiteWatch({ url: a.url, label: a.label ?? null });
        await rt.scrapers.checkSiteWatches();
      }
      const watches = await rt.scrapers.listSiteWatches();
      return json({
        watches: watches.map((w) => ({
          id: w.id,
          url: w.url,
          label: w.label,
          lastCheckedAt: w.lastCheckedAt,
          lastChangedAt: w.lastChangedAt,
          lastDiff: w.lastDiff,
          error: w.error,
        })),
      });
    }),
  );

  server.registerTool(
    "check_message",
    {
      title: "Check a message for financial-promotion red flags",
      description:
        "Before the owner sends a message about trading: flags promised or guaranteed returns, 'risk-free', 100% " +
        "success claims, time pressure, license claims and a missing risk warning (Arabic and English). " +
        "ok=false means do not send it as written. A check, not legal advice. Run it on every message you draft.",
      inputSchema: z.object({ text: z.string().min(1).max(4000) }),
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => json(checkMessage(a.text))),
  );

  server.registerTool(
    "read_page",
    {
      title: "Read a web page",
      description:
        "Read any public web page: title, description, language, readable text (up to 15k characters), links, " +
        "emails, phone numbers and the social accounts it links to. robots.txt is honored and internal addresses " +
        "are refused. Use it to look at a lead's website, a competitor's offer or any link the owner sends.",
      inputSchema: z.object({ url: z.string().min(4).max(2000) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (a) => json(await rt.readPage(a.url))),
  );

  server.registerTool(
    "add_account",
    {
      title: "Add a lead's account on another platform",
      description:
        "Attach a lead's TikTok, YouTube, Telegram, X, Facebook, LinkedIn or website by its address. YouTube channels " +
        "and public Telegram channels are then read through their official APIs (name, description, subscribers or members). " +
        "lead_detail lists every account a lead has.",
      inputSchema: z.object({ username: z.string(), url: z.string().max(500) }),
    },
    guard(async (a) => {
      const r = await rt.scrapers.addAccount({ username: a.username, url: a.url });
      if (r.ok) return json({ account: r.account });
      return fail(
        r.reason === "taken"
          ? "That account is already linked to another lead"
          : r.reason === "no_lead"
            ? `@${a.username} is not a collected account`
            : "Not an account address on a known platform",
      );
    }),
  );

  server.registerTool(
    "link_accounts",
    {
      title: "Link leads' other platforms",
      description:
        "Scan the bios and links of a project's leads for their accounts on other platforms (no network), link them, " +
        "and read up to `read` of them through the official connectors. New leads are linked automatically.",
      inputSchema: z.object({
        project: z.string(),
        read: z.number().int().min(0).max(200).default(30),
      }),
    },
    guard(async (a) =>
      json(
        await rt.scrapers.linkProjectAccounts(await projectIdFor(rt, a.project), { read: a.read }),
      ),
    ),
  );

  server.registerTool(
    "source_performance",
    {
      title: "Revenue by source",
      description:
        "For each source of a project (a competitor's followers, a post, a hashtag, an upload): accounts found, with " +
        "contact, reached, interested, customers, revenue (split evenly when an account came from several sources), " +
        "estimated collection cost, return per dollar, close rate, cost per customer and days to close. Use it to decide " +
        "which competitors to mine more and which to stop.",
      inputSchema: z.object({
        project: z.string(),
        days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe("Only leads collected in the last N days"),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (a) =>
      json(
        await rt.scrapers.sourcePerformance(await projectIdFor(rt, a.project), {
          ...(a.days ? { since: new Date(Date.now() - a.days * 86_400_000) } : {}),
        }),
      ),
    ),
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
