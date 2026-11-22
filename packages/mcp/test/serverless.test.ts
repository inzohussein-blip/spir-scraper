import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createTestRuntime, type TestRuntime } from "@scrapers/runtime/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMcpServer, SERVERLESS_MCP_OPTIONS } from "../src/index.js";

let rt: TestRuntime;
let client: Client;
const streams: string[] = [];

beforeAll(async () => {
  rt = await createTestRuntime();
  const handler = createMcpHandler(() => buildMcpServer(rt, {}), SERVERLESS_MCP_OPTIONS);
  // The 2026-07-28 protocol, as Claude speaks it.
  client = new Client({ name: "test", version: "1.0.0" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  } as never);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mcp.test/api/mcp"), {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const res = await handler.fetch(new Request(input, init));
        if (res.headers.get("content-type")?.includes("event-stream")) streams.push(res.url);
        return res;
      },
    }),
  );
});

afterAll(async () => {
  await client.close();
  await rt.close();
});

describe("MCP on a serverless host", () => {
  it("serves tools on the 2026-07-28 protocol", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("list_leads");
    const r = (await client.callTool({ name: "list_monitors", arguments: {} })) as {
      isError?: boolean;
    };
    expect(r.isError).toBeFalsy();
  });

  it("refuses subscriptions/listen at once instead of holding a stream open", async () => {
    const t0 = Date.now();
    await expect(client.listen({ toolsListChanged: true } as never)).rejects.toThrow(
      /Subscription limit/,
    );
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(streams).toHaveLength(0);
  });
});
