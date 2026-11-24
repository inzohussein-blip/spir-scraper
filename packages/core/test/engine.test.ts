import { describe, expect, it } from "vitest";
import { mentionsIn } from "../src/extract/mentions.js";
import {
  engineCandidates,
  inQuietHours,
  keywordHits,
  restMinutes,
} from "../src/pipeline/features/engine.js";
import type { RawProfile } from "../src/types.js";
import { FakeProvider, setup } from "./helpers.js";

const profile = (username: string, extra: Partial<RawProfile> = {}): RawProfile => ({
  igUserId: `id-${username}`,
  username,
  fullName: null,
  bio: null,
  followers: 1000,
  isBusiness: true,
  isVerified: false,
  ...extra,
});

describe("engine helpers", () => {
  it("finds mentions, linked accounts and keyword hits", () => {
    expect(mentionsIn("شريكنا @Gold.Academy و @fx_ksa. email a@b.com")).toEqual([
      "gold.academy",
      "fx_ksa",
    ]);
    const p = profile("coach", {
      bio: "مدرب تداول، شريك @gold.academy",
      externalUrl: "https://instagram.com/fx_ksa",
      recentPosts: [
        { likes: 1, comments: 1, caption: "مع @gold.academy و @guest1" },
        { likes: 1, comments: 1, caption: "@coach نفسه" },
      ],
    });
    const c = engineCandidates(p);
    expect(c[0]).toEqual({ username: "gold.academy", weight: 4 });
    expect(c.map((x) => x.username).sort()).toEqual(["fx_ksa", "gold.academy", "guest1"]);
    expect(keywordHits(p, ["تداول", "ذهب", "gold"])).toEqual(["تداول", "gold"]);
    expect(inQuietHours({ quietFrom: 2, quietTo: 7 } as never, 3)).toBe(true);
    expect(inQuietHours({ quietFrom: 23, quietTo: 6 } as never, 1)).toBe(true);
    expect(inQuietHours({ quietFrom: 23, quietTo: 6 } as never, 12)).toBe(false);
    expect([1, 2, 3, 10].map(restMinutes)).toEqual([30, 60, 120, 720]);
  });
});

describe("Spir engine", () => {
  it("crawls slowly from seeds, follows mentions on topic, rests when refused, and sends leads", async () => {
    // Any paid read would fail this test: the engine's accounts come from the cache.
    const paid = new FakeProvider("apify", ["profile"], {
      profile: () => {
        throw new Error("paid read");
      },
    });
    const t = await setup([paid]);
    try {
      const s = t.scrapers;
      await s.saveEngineSettings({
        intervalSec: 60,
        jitterSec: 0,
        quietFrom: 0,
        quietTo: 0,
        dailyCap: 100,
      });
      const p = await s.createProject({ name: "محرك", owner: "o" });
      const run = await s.createEngineRun({
        name: "مدربون",
        projectId: p.id,
        seeds: ["@seed1"],
        keywords: ["تداول"],
        maxDepth: 1,
        maxAccounts: 10,
      });
      let now = new Date("2030-01-01T12:00:00Z");
      const tick = (sec: number) => {
        now = new Date(now.getTime() + sec * 1000);
      };

      const first = await s.engineNext(now);
      expect(first).toMatchObject({ action: "read", item: { username: "seed1" } });
      // Too soon for another account: the platform keeps the pace.
      expect(await s.engineNext(now)).toMatchObject({ action: "wait", reason: "pace" });

      tick(30);
      const id = (first as { item: { id: string } }).item.id;
      let next = await s.engineReport(
        {
          itemId: id,
          status: "ok",
          profile: profile("seed1", {
            bio: "مدرب تداول. فريقي @coach_a @coach_b",
            recentPosts: [{ likes: 5, comments: 1, caption: "ضيفنا @guest" }],
          }),
        },
        now,
      );
      expect(next).toMatchObject({ action: "wait", reason: "pace" });
      const detail = await s.engineRun(run.id);
      expect(detail?.queue).toMatchObject({ done: 1, queued: 3 });
      expect(detail?.next[0]?.username).toMatch(/coach_/);

      // Instagram refuses: the engine rests 30 minutes and the account stays queued.
      tick(31);
      next = await s.engineNext(now);
      expect(next.action).toBe("read");
      const refused = (next as { item: { id: string; username: string } }).item;
      next = await s.engineReport({ itemId: refused.id, status: "rate_limited" }, now);
      expect(next).toMatchObject({ action: "wait", reason: "resting" });
      expect((await s.engineStatus(now)).state).toBe("resting");

      // After the rest it continues; depth 1 accounts are read but not followed further.
      tick(31 * 60);
      const read: string[] = [];
      for (let i = 0; i < 5; i++) {
        next = await s.engineNext(now);
        if (next.action !== "read") break;
        read.push(next.item.username);
        const onTopic = next.item.username !== "guest";
        await s.engineReport(
          {
            itemId: next.item.id,
            status: "ok",
            profile: profile(next.item.username, {
              bio: onTopic ? "تداول @deeper" : "طبخ",
            }),
          },
          now,
        );
        tick(61);
      }
      expect(read.sort()).toEqual(["coach_a", "coach_b", "guest"]);
      const after = await s.engineRun(run.id);
      expect(after?.run.status).toBe("done");
      expect(after?.run.counts).toMatchObject({ read: 4, accepted: 3, skipped: 1 });
      const data = await s.engineDataset(run.id);
      expect(data.find((d) => d.username === "guest")).toMatchObject({
        accepted: false,
        note: "لا يطابق الكلمات",
      });

      // Accepted accounts became a project job, read from the cache (no paid read).
      for (let i = 0; i < 20; i++) if ((await s.drain({ budgetMs: 5_000 })).activeJobs === 0) break;
      const leads = await s.listLeads({ projectId: p.id });
      expect(leads.map((l) => l.username).sort()).toEqual(["coach_a", "coach_b", "seed1"]);
      expect(paid.calls).toBe(0);
      expect((await s.engineEvents(10)).map((e) => e.kind)).toEqual(
        expect.arrayContaining(["start", "rest", "done"]),
      );
    } finally {
      await t.close();
    }
  });

  it("stops at the daily cap, in quiet hours and when switched off", async () => {
    const t = await setup([]);
    try {
      const s = t.scrapers;
      const p = await s.createProject({ name: "p", owner: "o" });
      await s.createEngineRun({
        name: "r",
        projectId: p.id,
        seeds: ["a1", "a2", "a3"],
        maxDepth: 0,
      });
      await s.saveEngineSettings({ dailyCap: 1, quietFrom: 0, quietTo: 0, intervalSec: 20 });
      const now = new Date("2030-01-01T12:00:00Z");
      const n1 = await s.engineNext(now);
      expect(n1.action).toBe("read");
      await s.engineReport(
        { itemId: (n1 as { item: { id: string } }).item.id, status: "not_found" },
        now,
      );
      expect(await s.engineNext(new Date(now.getTime() + 60_000))).toMatchObject({
        reason: "daily_cap",
      });
      // 12:00 UTC is 15:00 in Baghdad.
      await s.saveEngineSettings({ dailyCap: 100, quietFrom: 14, quietTo: 16 });
      expect(await s.engineNext(new Date(now.getTime() + 60_000))).toMatchObject({
        reason: "quiet",
      });
      await s.saveEngineSettings({ enabled: false });
      expect(await s.engineNext(now)).toMatchObject({ reason: "paused" });
      expect((await s.saveEngineSettings({ intervalSec: 1 })).intervalSec).toBe(20);
    } finally {
      await t.close();
    }
  });
});

describe("Spir engine workers and proxies", () => {
  it("tracks workers, hands proxy settings to the program once, and delivers commands", async () => {
    const t = await setup([]);
    try {
      const s = t.scrapers;
      await s.saveEngineSettings({ quietFrom: 0, quietTo: 0, intervalSec: 20 });
      const p = await s.createProject({ name: "p", owner: "o" });
      await s.createEngineRun({ name: "r", projectId: p.id, seeds: ["a1", "a2"], maxDepth: 0 });
      const proxy = await s.addEngineProxy({
        label: "proxy.example:8000",
        urlEnc: "ENC1",
        rotateUrlEnc: "ENC2",
      });
      const program = { id: "pc-1", kind: "program" as const, name: "جهاز البيت", ip: "1.2.3.4" };
      const now = new Date("2030-01-01T12:00:00Z");

      const first = await s.engineNext(now, program);
      expect(first.action).toBe("read");
      expect(first.config?.proxies).toEqual([
        { id: proxy?.id, urlEnc: "ENC1", rotateUrlEnc: "ENC2" },
      ]);
      const version = first.config?.version ?? null;
      // Same version: not sent again. The extension never gets proxies.
      const again = await s.engineNext(now, { ...program, configVersion: version });
      expect(again.config).toBeUndefined();
      expect((await s.engineNext(now, { id: "ext-1", kind: "extension" })).config).toBeUndefined();

      // A refusal through the proxy rests that proxy and counts it.
      await s.engineReport(
        {
          itemId: (first as { item: { id: string } }).item.id,
          status: "rate_limited",
          exitId: proxy?.id ?? null,
          message: "429",
        },
        now,
        { ...program, configVersion: version },
      );
      const [px] = await s.listEngineProxies();
      expect(px).toMatchObject({ failures: 1, lastError: "429" });
      expect(px?.restingUntil).not.toBeNull();

      // "Change IP" goes to the program only, once.
      await s.queueEngineCommand({ type: "rotate", proxyId: proxy?.id as string });
      await s.queueEngineCommand({ type: "check_ip" });
      expect((await s.engineNext(now, { id: "ext-1", kind: "extension" })).commands).toEqual([
        expect.objectContaining({ type: "check_ip" }),
      ]);
      const cmds = (await s.engineNext(now, { ...program, configVersion: version })).commands;
      expect(cmds?.map((c) => c.type)).toEqual(["rotate", "check_ip"]);
      expect(
        (await s.engineNext(now, { ...program, configVersion: version })).commands,
      ).toBeUndefined();

      // A worker switched off waits; the list shows both.
      await s.setEngineWorkerDisabled("ext-1", true);
      expect(await s.engineNext(now, { id: "ext-1", kind: "extension" })).toMatchObject({
        reason: "worker_off",
      });
      const workers = await s.listEngineWorkers();
      expect(workers.map((w) => w.id).sort()).toEqual(["ext-1", "pc-1"]);
      expect(workers.find((w) => w.id === "pc-1")).toMatchObject({ ip: "1.2.3.4", reads: 1 });

      // Disabling the proxy changes the version, so the program gets the new list.
      await s.updateEngineProxy(proxy?.id as string, { enabled: false });
      const fresh = await s.engineNext(now, { ...program, configVersion: version });
      expect(fresh.config?.proxies).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
