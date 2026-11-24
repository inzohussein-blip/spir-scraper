import { describe, expect, it } from "vitest";
import { type EngineState, engineTick, mapProfile, readAnonymously } from "../src/engine.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const USER = {
  id: "42",
  username: "Coach",
  biography: "مدرب تداول @gold.academy",
  edge_followed_by: { count: 5000 },
  is_business_account: true,
  edge_owner_to_timeline_media: {
    count: 1,
    edges: [
      {
        node: {
          shortcode: "AB",
          edge_media_to_caption: { edges: [{ node: { text: "مع @guest" } }] },
        },
      },
    ],
  },
};

const state = (): EngineState => ({
  enabled: true,
  workerId: "ext-1",
  ip: "9.9.9.9",
  last: null,
  readToday: 0,
  day: "2030-01-01",
});

describe("engine mode", () => {
  it("maps the public profile", () => {
    expect(mapProfile(USER)).toMatchObject({
      igUserId: "42",
      username: "coach",
      followers: 5000,
      isBusiness: true,
      recentPosts: [{ caption: "مع @guest", url: "https://www.instagram.com/p/AB/" }],
    });
  });

  it("reads without the owner's cookies and names refusals", async () => {
    const seen: RequestInit[] = [];
    const ok = await readAnonymously(async (_u, init) => {
      seen.push(init ?? {});
      return json({ data: { user: USER } });
    }, "coach");
    expect(ok.status).toBe("ok");
    expect(seen[0]?.credentials).toBe("omit");
    const status = async (res: Response) => (await readAnonymously(async () => res, "x")).status;
    expect(await status(json({}, 429))).toBe("rate_limited");
    expect(await status(json({}, 404))).toBe("not_found");
    expect(await status(json({}, 401))).toBe("blocked");
    expect(await status(json({ data: { user: null } }))).toBe("not_found");
    expect(await status(new Response("<html>"))).toBe("blocked");
  });

  it("asks, reads, reports and waits as the platform says", async () => {
    const calls: { url: string; body: Record<string, unknown> | null }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/api/engine/next"))
        return json({ action: "read", item: { id: "q1", username: "coach" } });
      if (url.endsWith("/api/engine/report"))
        return json({ action: "wait", seconds: 75, reason: "pace" });
      if (url.includes("instagram.com")) return json({ data: { user: USER } });
      return json({ ip: "1.1.1.1" });
    };
    const r = await engineTick({
      platformUrl: "https://x.app/",
      key: "sk_1",
      state: state(),
      version: "0.2.0",
      fetchFn,
      now: new Date("2030-01-01T10:00:00Z"),
    });
    expect(r.waitSeconds).toBe(75);
    expect(r.state.readToday).toBe(1);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/engine/next",
      "/api/v1/users/web_profile_info/",
      "/api/engine/report",
    ]);
    expect(calls[0]?.body?.worker).toMatchObject({ id: "ext-1", kind: "extension", ip: "9.9.9.9" });
    expect((calls[2]?.body?.reports as unknown[] | undefined)?.[0]).toMatchObject({
      itemId: "q1",
      status: "ok",
      exitId: "direct",
    });
  });

  it("reads a batch one account per visit and reports it all at the end", async () => {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.startsWith("/api/engine"))
        posts.push({ path, body: JSON.parse(String(init?.body)) });
      if (path === "/api/engine/next")
        return json({
          action: "batch",
          intervalSec: 60,
          jitterSec: 0,
          items: [
            { id: "q1", username: "a" },
            { id: "q2", username: "b" },
            { id: "q3", username: "c" },
          ],
        });
      if (path === "/api/engine/report")
        return json({ action: "wait", seconds: 1800, reason: "pace" });
      if (url.includes("username=b")) return json({}, 429);
      return json({ data: { user: { ...USER, username: "a" } } });
    };
    const run = (st: EngineState) =>
      engineTick({ platformUrl: "https://x.app", key: "k", state: st, version: "1", fetchFn });
    const first = await run(state());
    expect(first.waitSeconds).toBe(60);
    expect(posts.map((p) => p.path)).toEqual(["/api/engine/next"]);
    expect(posts[0]?.body.worker).toMatchObject({ batch: true });
    // b is refused: c is handed back and the batch is reported in one visit.
    const second = await run(first.state);
    expect(second.waitSeconds).toBe(1800);
    expect(posts.map((p) => p.path)).toEqual(["/api/engine/next", "/api/engine/report"]);
    const reports = posts[1]?.body.reports as { itemId: string; status: string }[];
    expect(reports.map((r) => r.status)).toEqual(["ok", "rate_limited", "released"]);
    expect(second.state.batch).toBeNull();
  });

  it("keeps the reports when the platform cannot be reached, and explains a refused key", async () => {
    let up = false;
    const fetchFn = async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/api/engine/report")
        return up ? json({ action: "wait", seconds: 600, reason: "idle" }) : json({}, 503);
      return json({ data: { user: USER } });
    };
    const st: EngineState = {
      ...state(),
      batch: {
        items: [{ id: "q1", username: "coach" }],
        intervalSec: 60,
        jitterSec: 0,
        reports: [],
      },
    };
    const failed = await engineTick({
      platformUrl: "https://x.app",
      key: "k",
      state: st,
      version: "1",
      fetchFn,
    });
    expect(failed.waitSeconds).toBe(300);
    expect(failed.state.batch?.reports).toHaveLength(1);
    up = true;
    const sent = await engineTick({
      platformUrl: "https://x.app",
      key: "k",
      state: failed.state,
      version: "1",
      fetchFn,
    });
    expect(sent.waitSeconds).toBe(600);
    expect(sent.state.batch).toBeNull();
    const refused = await engineTick({
      platformUrl: "https://x.app",
      key: "bad",
      state: state(),
      version: "1",
      fetchFn: async () => json({}, 404),
    });
    expect(refused.waitSeconds).toBe(300);
    expect(refused.state.last?.text).toMatch(/المفتاح/);
  });
});
