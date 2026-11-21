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
});
