import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  JobNotFoundError,
  parseSource,
  type Source,
  SourceError,
  uploadSource,
} from "@scrapers/core";
import type { Runtime } from "@scrapers/runtime";
import type { Context, Next } from "hono";

export interface ApiOptions {
  /** Called after a job is queued, e.g. to process it on a serverless host. */
  onJobStarted?: (jobId: string) => void;
  maxLimit?: number;
}

type Env = { Variables: { scopes: string[] } };

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const ProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    owner: z.string(),
    sheetId: z.string().nullable(),
    aiCriteria: z.string().nullable(),
    retentionDays: z.number(),
    createdAt: z.string(),
  })
  .openapi("Project");
const JobSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    sourceType: z.string(),
    sourceUrl: z.string(),
    limit: z.number(),
    provider: z.string().nullable(),
    status: z.string(),
    counts: z.record(z.string(), z.unknown()),
    error: z.string().nullable(),
    progress: z.number(),
  })
  .openapi("Job");
const LeadSchema = z
  .object({
    username: z.string(),
    fullName: z.string().nullable(),
    category: z.string().nullable(),
    followers: z.number().nullable(),
    isBusiness: z.boolean(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    phoneCountry: z.string().nullable(),
    phoneConfirmed: z.boolean(),
    contactSource: z.string().nullable(),
    aiScore: z.number().nullable(),
    aiTags: z.array(z.string()).nullable(),
    aiReason: z.string().nullable(),
    sourceUrl: z.string(),
    fetchedAt: z.string(),
  })
  .openapi("Lead");

const bool = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => v === "true");
const jsonOf = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const errors = {
  400: jsonOf(ErrorSchema, "Bad request"),
  401: jsonOf(ErrorSchema, "Missing or invalid API key"),
  403: jsonOf(ErrorSchema, "Key lacks the scope"),
  404: jsonOf(ErrorSchema, "Not found"),
};
/** JSON-safe copy (dates become ISO strings). */
const plain = <T>(v: T) => JSON.parse(JSON.stringify(v));

/**
 * The REST API (/v1). Every route needs `Authorization: Bearer sk_...`;
 * GET routes need the read scope, others the write scope.
 */
export function createApi(getRuntime: () => Promise<Runtime>, opts: ApiOptions = {}) {
  const maxLimit = opts.maxLimit ?? 1000;
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          { error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
          400,
        );
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
  });

  const auth = async (c: Context<Env>, next: Next) => {
    const header = c.req.header("authorization") ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const verified = key ? await (await getRuntime()).scrapers.verifyApiKey(key) : null;
    if (!verified) return c.json({ error: "Missing or invalid API key" }, 401);
    const needed = c.req.method === "GET" ? "read" : "write";
    if (!verified.scopes.includes(needed))
      return c.json({ error: `This key lacks the ${needed} scope` }, 403);
    c.set("scopes", verified.scopes);
    await next();
  };
  app.use("/v1/*", auth);

  app.onError((err, c) => {
    if (err instanceof SourceError) return c.json({ error: err.message }, 400);
    if (err instanceof JobNotFoundError) return c.json({ error: err.message }, 404);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  const projectExists = async (rt: Runtime, id: string) => !!(await rt.scrapers.getProject(id));

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/projects",
      security: [{ bearer: [] }],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                name: z.string().min(1).max(100),
                sheetId: z.string().optional(),
                aiCriteria: z.string().optional(),
                retentionDays: z.number().int().min(1).max(365).optional(),
              }),
            },
          },
        },
      },
      responses: { 201: jsonOf(ProjectSchema, "Created"), ...errors },
    }),
    async (c) => {
      const rt = await getRuntime();
      const body = c.req.valid("json");
      const p = await rt.scrapers.createProject({
        name: body.name,
        owner: rt.owner,
        ...(body.sheetId ? { sheetId: body.sheetId } : {}),
        ...(body.aiCriteria ? { aiCriteria: body.aiCriteria } : {}),
        ...(body.retentionDays ? { retentionDays: body.retentionDays } : {}),
      });
      return c.json(plain(p), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects",
      security: [{ bearer: [] }],
      responses: { 200: jsonOf(z.object({ projects: z.array(ProjectSchema) })), ...errors },
    }),
    async (c) =>
      c.json({ projects: plain(await (await getRuntime()).scrapers.listProjects()) }, 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{id}",
      security: [{ bearer: [] }],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: { 200: jsonOf(ProjectSchema), ...errors },
    }),
    async (c) => {
      const p = await (await getRuntime()).scrapers.getProject(c.req.valid("param").id);
      return p ? c.json(plain(p), 200) : c.json({ error: "Project not found" }, 404);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/jobs",
      security: [{ bearer: [] }],
      description:
        "Queue a job. Send either `source` (URL, @username, #hashtag) or `usernames`. Supports Idempotency-Key.",
      request: {
        headers: z.object({ "idempotency-key": z.string().max(200).optional() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                projectId: z.string().uuid(),
                source: z.string().optional(),
                sourceType: z.enum(["profile", "post", "hashtag"]).optional(),
                usernames: z.array(z.string()).max(5000).optional(),
                limit: z.number().int().min(1).max(maxLimit).default(100),
              }),
            },
          },
        },
      },
      responses: {
        202: jsonOf(z.object({ job: JobSchema, estimatedCostUsd: z.number() }), "Queued"),
        ...errors,
      },
    }),
    async (c) => {
      const rt = await getRuntime();
      const body = c.req.valid("json");
      if (!(await projectExists(rt, body.projectId)))
        return c.json({ error: "Project not found" }, 404);
      const idem = c.req.valid("header")["idempotency-key"];
      if (idem) {
        const prior = idempotency.get(idem);
        if (prior) return c.json(prior, 202);
      }
      let source: Source;
      if (body.usernames?.length)
        source = uploadSource(
          body.usernames.map((u) => u.replace(/^@/, "").toLowerCase()),
          "api:usernames",
        );
      else if (body.source) source = parseSource(body.source, body.sourceType);
      else return c.json({ error: "Send source or usernames" }, 400);
      const { job, estimatedCostUsd } = await rt.scrapers.startJob({
        projectId: body.projectId,
        source,
        limit: body.limit,
      });
      opts.onJobStarted?.(job.id);
      const full = await rt.scrapers.getJob(job.id);
      const res = { job: plain(full), estimatedCostUsd };
      if (idem) remember(idem, res);
      return c.json(res, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/jobs/{id}",
      security: [{ bearer: [] }],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: { 200: jsonOf(JobSchema), ...errors },
    }),
    async (c) =>
      c.json(plain(await (await getRuntime()).scrapers.getJob(c.req.valid("param").id)), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/jobs/{id}/cancel",
      security: [{ bearer: [] }],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: { 200: jsonOf(JobSchema), ...errors },
    }),
    async (c) =>
      c.json(plain(await (await getRuntime()).scrapers.cancelJob(c.req.valid("param").id)), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/jobs/{id}/score",
      security: [{ bearer: [] }],
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({ criteria: z.string().min(3), rescore: z.boolean().optional() }),
            },
          },
        },
      },
      responses: {
        200: jsonOf(
          z.object({ mode: z.string(), count: z.number(), batchId: z.string().optional() }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const rt = await getRuntime();
      if (!rt.scrapers.scoringAvailable)
        return c.json({ error: "AI scoring needs ANTHROPIC_API_KEY on the server" }, 400);
      const { criteria, rescore } = c.req.valid("json");
      return c.json(
        await rt.scrapers.scoreLeads(c.req.valid("param").id, criteria, rescore ? { rescore } : {}),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/jobs/{id}/export",
      security: [{ bearer: [] }],
      description: "csv/xlsx return the file; sheet writes to Google Sheets and returns its link.",
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                format: z.enum(["csv", "xlsx", "sheet"]),
                sheetMode: z.enum(["new-file", "new-tab", "append"]).optional(),
                spreadsheetId: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "File or sheet result",
          content: {
            "application/json": {
              schema: z.object({
                spreadsheetId: z.string(),
                url: z.string(),
                tab: z.string(),
                written: z.number(),
              }),
            },
            "text/csv": { schema: z.string() },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      const rt = await getRuntime();
      const job = await rt.scrapers.getJob(c.req.valid("param").id);
      const body = c.req.valid("json");
      const r = await rt.exportLeads({
        projectId: job.projectId,
        jobId: job.id,
        format: body.format,
        ...(body.sheetMode ? { sheetMode: body.sheetMode } : {}),
        ...(body.spreadsheetId ? { spreadsheetId: body.spreadsheetId } : {}),
      });
      if (r.kind === "sheet") return c.json(r, 200);
      return new Response(new Uint8Array(r.data), {
        headers: {
          "content-type": r.contentType,
          "content-disposition": `attachment; filename="scrapers-export.${r.filename.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(r.filename)}`,
        },
      }) as never;
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/leads",
      security: [{ bearer: [] }],
      request: {
        query: z.object({
          project: z.string().uuid(),
          job: z.string().uuid().optional(),
          business: bool,
          has_email: bool,
          has_phone: bool,
          min_score: z.coerce.number().int().min(0).max(100).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(50),
          cursor: z.coerce.number().int().min(0).default(0),
        }),
      },
      responses: {
        200: jsonOf(z.object({ leads: z.array(LeadSchema), nextCursor: z.number().nullable() })),
        ...errors,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const leads = await (await getRuntime()).scrapers.listLeads({
        projectId: q.project,
        ...(q.job ? { jobId: q.job } : {}),
        ...(q.business ? { business: true } : {}),
        ...(q.has_email ? { hasEmail: true } : {}),
        ...(q.has_phone ? { hasPhone: true } : {}),
        ...(q.min_score !== undefined ? { minScore: q.min_score } : {}),
        limit: q.limit,
        offset: q.cursor,
      });
      return c.json(
        { leads: plain(leads), nextCursor: leads.length === q.limit ? q.cursor + q.limit : null },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/profiles/{username}",
      security: [{ bearer: [] }],
      request: { params: z.object({ username: z.string() }) },
      responses: { 200: jsonOf(z.record(z.string(), z.unknown())), ...errors },
    }),
    async (c) => {
      const p = await (await getRuntime()).scrapers.getStoredProfile(c.req.valid("param").username);
      return p ? c.json(plain(p), 200) : c.json({ error: "Profile not collected" }, 404);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/suppression",
      security: [{ bearer: [] }],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                kind: z.enum(["username", "email", "phone"]),
                value: z.string().min(1),
                reason: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: { 200: jsonOf(z.object({ suppressed: z.string() })), ...errors },
    }),
    async (c) => {
      const { kind, value, reason } = c.req.valid("json");
      await (await getRuntime()).scrapers.suppress(kind, value, reason);
      return c.json({ suppressed: kind }, 200);
    },
  );

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Scrapers API",
      version: "1.0.0",
      description: "Leads from public Instagram data.",
    },
  });

  return app;
}

// Idempotency keys for POST /v1/jobs, kept per instance for 24h.
const idempotency = new Map<string, unknown>();
function remember(key: string, value: unknown) {
  idempotency.set(key, value);
  setTimeout(() => idempotency.delete(key), 24 * 3600_000).unref?.();
}
