import type { CreateMcpHandlerOptions } from "@modelcontextprotocol/server";

/**
 * Options for serving MCP from serverless functions (Vercel).
 *
 * `subscriptions/listen` (protocol 2026-07-28) is always an open SSE stream
 * waiting for change events. On a serverless host it keeps the function
 * running until its time limit, then the client reconnects: a function busy
 * around the clock while Claude is connected. Each instance has its own
 * in-memory event bus and this server publishes no change events, so such a
 * stream would never deliver anything. New listens are refused at once.
 */
export const SERVERLESS_MCP_OPTIONS = {
  maxSubscriptions: 0,
  keepAliveMs: 0,
} satisfies CreateMcpHandlerOptions;
