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
      "add_lead_note",
      "analyze_competitor",
      "bulk_update_leads",
      "cancel_job",
      "export_leads",
      "get_job",
      "get_profile",
      "lead_detail",
      "list_leads",
      "list_monitors",
      "score_leads",
      "set_lead_status",
      "start_job",
      "suppress",
      "update_project",
      "watch_competitor",
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

  it("changes many leads, keeps notes and shows a lead's history", async () => {
    const bulk = await call("bulk_update_leads", {
      project: "عبر Claude",
      usernames: ["user2", "user3"],
      status: "interested",
      follow_up_at: "2030-01-02",
    });
    expect(bulk.structuredContent).toEqual({ updated: 2 });
    expect(
      (await call("add_lead_note", { project: "عبر Claude", username: "user2", text: "اتصلت" }))
        .structuredContent,
    ).toEqual({ added: true });
    const d = await call("lead_detail", { project: "عبر Claude", username: "@user2" });
    expect(d.structuredContent.lead.status).toBe("interested");
    expect(d.structuredContent.events.map((e: { kind: string }) => e.kind)).toEqual([
      "note",
      "status",
    ]);
    expect((await call("lead_detail", { project: "عبر Claude", username: "nobody" })).isError).toBe(
      true,
    );
    const interested = await call("list_leads", { project: "عبر Claude", status: "interested" });
    expect(interested.structuredContent.count).toBe(2);
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

  it("sets lead status, searches, updates projects and watches competitors", async () => {
    await call("start_job", { usernames: ["user6", "user8"], project: "crm", limit: 5 });
    await settle(rt);
    expect(
      (
        await call("set_lead_status", {
          project: "crm",
          username: "user6",
          status: "customer",
          note: "دفع",
        })
      ).isError,
    ).toBeFalsy();
    expect(
      (await call("set_lead_status", { project: "crm", username: "nobody", status: "customer" }))
        .isError,
    ).toBe(true);
    const customers = await call("list_leads", { project: "crm", status: "customer" });
    expect(customers.structuredContent.leads).toEqual([
      expect.objectContaining({ username: "user6", status: "customer", statusNote: "دفع" }),
    ]);
    const page = await call("list_leads", { project: "crm", limit: 1 });
    expect(page.structuredContent.next_cursor).toEqual(expect.any(String));
    const next = await call("list_leads", {
      project: "crm",
      limit: 1,
      cursor: page.structuredContent.next_cursor,
    });
    expect(next.structuredContent.leads[0].username).not.toBe(
      page.structuredContent.leads[0].username,
    );
    expect(
      (await call("list_leads", { project: "crm", search: "user8" })).structuredContent.count,
    ).toBe(1);
    const p = await call("update_project", {
      project: "crm",
      auto_export: true,
      watch_keywords: ["coach"],
    });
    expect(p.structuredContent).toMatchObject({ autoExport: true, watchKeywords: ["coach"] });
    const m = await call("watch_competitor", { project: "crm", source: "#forex", every_days: 3 });
    expect(m.structuredContent.every_days).toBe(3);
    expect(
      (await call("list_monitors", { project: "crm" })).structuredContent.monitors,
    ).toHaveLength(1);
  });
});
