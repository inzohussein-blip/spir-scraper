import { createTestRuntime, settle, type TestRuntime } from "@scrapers/runtime/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/index.js";

let rt: TestRuntime;
let app: ReturnType<typeof createApi>;
let writeKey: string;
let readKey: string;
const started: string[] = [];

beforeAll(async () => {
  rt = await createTestRuntime();
  app = createApi(async () => rt, { onJobStarted: (id) => started.push(id), maxLimit: 500 });
  writeKey = (await rt.scrapers.createApiKey("w", ["read", "write"])).key;
  readKey = (await rt.scrapers.createApiKey("r", ["read"])).key;
});
afterAll(() => rt.close());

const req = (
  method: string,
  path: string,
  key: string | null,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("REST API", () => {
  it("requires a valid key and the right scope", async () => {
    expect((await req("GET", "/v1/projects", null)).status).toBe(401);
    expect((await req("GET", "/v1/projects", "sk_bad")).status).toBe(401);
    expect((await req("GET", "/v1/projects", readKey)).status).toBe(200);
    expect((await req("POST", "/v1/projects", readKey, { name: "x" })).status).toBe(403);
  });

  it("runs the full flow: project, job, leads, export, suppress", async () => {
    const p = (await (
      await req("POST", "/v1/projects", writeKey, { name: "n8n", retentionDays: 30 })
    ).json()) as any;
    expect(p).toMatchObject({ name: "n8n", retentionDays: 30 });
    expect((await req("GET", `/v1/projects/${p.id}`, readKey)).status).toBe(200);

    const created = await req(
      "POST",
      "/v1/jobs",
      writeKey,
      { projectId: p.id, usernames: ["@user2", "user3"], limit: 10 },
      { "idempotency-key": "abc" },
    );
    expect(created.status).toBe(202);
    const { job } = (await created.json()) as any;
    expect(started).toEqual([job.id]);
    const again = (await (
      await req(
        "POST",
        "/v1/jobs",
        writeKey,
        { projectId: p.id, usernames: ["user9"] },
        { "idempotency-key": "abc" },
      )
    ).json()) as any;
    expect(again.job.id).toBe(job.id);
    expect(started).toHaveLength(1);

    await settle(rt);
    expect((await (await req("GET", `/v1/jobs/${job.id}`, readKey)).json()) as any).toMatchObject({
      status: "done",
      progress: 1,
    });

    const leads = (await (
      await req("GET", `/v1/leads?project=${p.id}&has_phone=true`, readKey)
    ).json()) as any;
    expect(leads.leads).toHaveLength(1);
    expect(leads.leads[0]).toMatchObject({ username: "user2", phoneConfirmed: true });
    expect(leads.nextCursor).toBeNull();

    const csv = await req("POST", `/v1/jobs/${job.id}/export`, writeKey, { format: "csv" });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("attachment");
    expect((await csv.text()).split("\n").length).toBeGreaterThanOrEqual(3);

    expect((await req("GET", "/v1/profiles/user2", readKey)).status).toBe(200);
    expect(
      (await req("POST", "/v1/suppression", writeKey, { kind: "username", value: "user2" })).status,
    ).toBe(200);
    expect((await req("GET", "/v1/profiles/user2", readKey)).status).toBe(404);
    expect((await req("POST", `/v1/jobs/${job.id}/cancel`, writeKey)).status).toBe(200);
  });

  it("validates input and maps errors", async () => {
    const p = (await (await req("POST", "/v1/projects", writeKey, { name: "v" })).json()) as any;
    expect(
      (await req("POST", "/v1/jobs", writeKey, { projectId: p.id, source: "https://evil.com/x" }))
        .status,
    ).toBe(400);
    expect((await req("POST", "/v1/jobs", writeKey, { projectId: p.id })).status).toBe(400);
    expect(
      (await req("POST", "/v1/jobs", writeKey, { projectId: p.id, usernames: ["a"], limit: 501 }))
        .status,
    ).toBe(400);
    expect(
      (
        await req("POST", "/v1/jobs", writeKey, {
          projectId: "00000000-0000-0000-0000-000000000000",
          usernames: ["a"],
        })
      ).status,
    ).toBe(404);
    expect(
      (await req("GET", "/v1/jobs/00000000-0000-0000-0000-000000000000", readKey)).status,
    ).toBe(404);
    expect((await req("GET", "/v1/jobs/not-a-uuid", readKey)).status).toBe(400);
    const score = await req(
      "POST",
      "/v1/jobs/00000000-0000-0000-0000-000000000000/score",
      writeKey,
      { criteria: "partners" },
    );
    expect(await score.json()).toMatchObject({
      error: expect.stringContaining("ANTHROPIC_API_KEY"),
    });
  });

  it("publishes an OpenAPI document", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(["/v1/jobs", "/v1/leads", "/v1/jobs/{id}/export"]),
    );
  });

  it("limits requests per key and says when to retry", async () => {
    const limited = createApi(async () => rt, { rateLimitPerMinute: 2 });
    const k = (await rt.scrapers.createApiKey("burst", ["read"])).key;
    const hit = () =>
      limited.request("/v1/projects", { headers: { authorization: `Bearer ${k}` } });
    const first = await hit();
    expect(first.headers.get("x-ratelimit-remaining")).toBe("1");
    expect((await hit()).status).toBe(200);
    const third = await hit();
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
  });

  it("keeps idempotency keys per API key in the database", async () => {
    const other = (await rt.scrapers.createApiKey("other", ["read", "write"])).key;
    const p = (await (await req("POST", "/v1/projects", writeKey, { name: "idem" })).json()) as any;
    const a = (await (
      await req(
        "POST",
        "/v1/jobs",
        writeKey,
        { projectId: p.id, usernames: ["u1"] },
        { "idempotency-key": "same" },
      )
    ).json()) as any;
    const b = (await (
      await req(
        "POST",
        "/v1/jobs",
        other,
        { projectId: p.id, usernames: ["u1"] },
        { "idempotency-key": "same" },
      )
    ).json()) as any;
    expect(a.job.id).not.toBe(b.job.id);
    const { rows } = await rt.pg.query<{ n: number }>(
      "select count(*)::int as n from ephemeral where key like 'idem:%'",
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(2);
  });
});

describe("REST API: lead workflow and monitors", () => {
  it("searches, pages with a cursor, sets status, updates projects and manages monitors", async () => {
    const p = (await (await req("POST", "/v1/projects", writeKey, { name: "crm" })).json()) as any;
    await req("POST", "/v1/jobs", writeKey, {
      projectId: p.id,
      usernames: ["user8", "user10", "user12"],
    });
    await settle(rt);
    const first = (await (
      await req("GET", `/v1/leads?project=${p.id}&limit=2`, readKey)
    ).json()) as any;
    expect(first.leads).toHaveLength(2);
    expect(typeof first.nextCursor).toBe("string");
    const second = (await (
      await req("GET", `/v1/leads?project=${p.id}&limit=2&cursor=${first.nextCursor}`, readKey)
    ).json()) as any;
    expect(second.leads).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      ((await (await req("GET", `/v1/leads?project=${p.id}&q=user10`, readKey)).json()) as any)
        .leads,
    ).toHaveLength(1);

    expect(
      (
        await req("POST", "/v1/leads/status", writeKey, {
          projectId: p.id,
          username: "user10",
          status: "interested",
          note: "اتصل الأحد",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await req("POST", "/v1/leads/status", writeKey, {
          projectId: p.id,
          username: "ghost",
          status: "interested",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req("POST", "/v1/leads/status", writeKey, {
          projectId: p.id,
          username: "user10",
          status: "maybe",
        })
      ).status,
    ).toBe(400);
    const interested = (await (
      await req("GET", `/v1/leads?project=${p.id}&status=interested`, readKey)
    ).json()) as any;
    expect(interested.leads[0]).toMatchObject({
      username: "user10",
      status: "interested",
      statusNote: "اتصل الأحد",
    });

    const patched = (await (
      await req("PATCH", `/v1/projects/${p.id}`, writeKey, {
        autoExport: true,
        watchKeywords: ["وكيل"],
      })
    ).json()) as any;
    expect(patched).toMatchObject({ autoExport: true, watchKeywords: ["وكيل"] });

    const m = (await (
      await req("POST", "/v1/monitors", writeKey, {
        projectId: p.id,
        source: "@competitor",
        everyDays: 3,
      })
    ).json()) as any;
    expect(m).toMatchObject({ sourceType: "profile", everyDays: 3, enabled: true });
    expect(
      ((await (await req("GET", `/v1/monitors?project=${p.id}`, readKey)).json()) as any).monitors,
    ).toHaveLength(1);
    expect(
      (await req("POST", "/v1/monitors", writeKey, { projectId: p.id, source: "https://evil.com" }))
        .status,
    ).toBe(400);
    expect((await req("DELETE", `/v1/monitors/${m.id}`, writeKey)).status).toBe(200);
  });
});
