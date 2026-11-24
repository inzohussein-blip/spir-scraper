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
    expect(calls[2]?.body).toMatchObject({ itemId: "q1", status: "ok", exitId: "direct" });
  });

  it("keeps an account handed over in a report answer for the next visit, and backs off on errors", async () => {
    const fetchFn = async (url: string) => {
      if (url.endsWith("/api/engine/next"))
        return json({ action: "read", item: { id: "q1", username: "a" } });
      if (url.endsWith("/api/engine/report"))
        return json({ action: "read", item: { id: "q2", username: "b" } });
      return json({ data: { user: { ...USER, username: "a" } } });
    };
    const first = await engineTick({
      platformUrl: "https://x.app",
      key: "k",
      state: state(),
      version: "1",
      fetchFn,
    });
    expect(first.state.pending).toEqual({ id: "q2", username: "b" });
    expect(first.waitSeconds).toBe(30);
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
