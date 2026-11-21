import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createTestRuntime, settle, type TestRuntime } from "@scrapers/runtime/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMcpServer } from "../src/index.js";

let rt: TestRuntime;
let client: Client;
const started: string[] = [];

type Result = {
  content: { type: string; text: string }[];
  isError?: boolean;
  structuredContent?: any;
};
const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as unknown as Result;

beforeAll(async () => {
  rt = await createTestRuntime();
  const handler = createMcpHandler(() =>
    buildMcpServer(rt, { onJobStarted: (id) => started.push(id), maxLimit: 500 }),
  );
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mcp.test/api/mcp"), {
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        handler.fetch(new Request(input, init)),
    }),
  );
});

afterAll(async () => {
  await client.close();
  await rt.close();
});

describe("MCP server over Streamable HTTP", () => {
  it("lists the planned tools, resources and prompts", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "cancel_job",
      "export_leads",
      "get_job",
      "get_profile",
      "list_leads",
      "score_leads",
      "start_job",
      "suppress",
    ]);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["audience_report", "find_partners"]);
  });

  it("starts a job from usernames, reports progress and lists leads", async () => {
    const r = await call("start_job", {
      usernames: ["@User2", "user3", "user4"],
      project: "عبر Claude",
      limit: 10,
    });
    expect(r.isError).toBeFalsy();
    const jobId = r.structuredContent.job_id as string;
    expect(started).toContain(jobId);
    await settle(rt);
    const job = await call("get_job", { job_id: jobId });
    expect(job.structuredContent).toMatchObject({
      status: "done",
      progress: 1,
      counts: { discovered: 3, enriched: 3 },
    });

    const leads = await call("list_leads", { project: "عبر Claude", has_phone: true });
    expect(leads.structuredContent.count).toBe(2);
    expect(leads.structuredContent.leads[0].phone).toMatch(/^\+964/);

    const prof = await call("get_profile", { username: "user2" });
    expect(prof.structuredContent.sources[0].sourceUrl).toBe("mcp:usernames");
    expect((await call("get_profile", { username: "nobody" })).isError).toBe(true);

    const res = await client.readResource({
      uri: `leads://${encodeURIComponent("عبر Claude")}/latest`,
    });
    expect(JSON.parse((res.contents[0] as { text: string }).text)).toHaveLength(3);
    const summary = await client.readResource({ uri: `jobs://${jobId}/summary` });
    expect(JSON.parse((summary.contents[0] as { text: string }).text).status).toBe("done");
  });

  it("reports bad input as tool errors, not crashes", async () => {
    expect(
      (await call("start_job", { source: "https://evil.com/x", project: "p" })).content[0]?.text,
    ).toMatch(/instagram\.com/);
    expect((await call("start_job", { project: "p" })).isError).toBe(true);
    expect(
      (await call("score_leads", { job_id: started[0], criteria: "partners" })).content[0]?.text,
    ).toMatch(/score the leads yourself/);
    expect((await call("export_leads", { project: "p" })).content[0]?.text).toMatch(
      /GOOGLE_SERVICE_ACCOUNT_JSON/,
    );
  });

  it("suppresses and cancels", async () => {
    await call("suppress", { kind: "username", value: "user4" });
    const leads = await call("list_leads", { project: "عبر Claude" });
    expect(
      leads.structuredContent.leads.map((l: { username: string }) => l.username),
    ).not.toContain("user4");
    const r = await call("start_job", { usernames: ["user9"], project: "x" });
    const c = await call("cancel_job", { job_id: r.structuredContent.job_id });
    expect(c.structuredContent.status).toBe("cancelled");
  });

  it("fills the find_partners prompt", async () => {
    const p = await client.getPrompt({
      name: "find_partners",
      arguments: { source: "@comp", project: "x", criteria: "agents" },
    });
    expect((p.messages[0]?.content as { text: string } | undefined)?.text).toContain(
      'start_job with source "@comp"',
    );
  });
});
