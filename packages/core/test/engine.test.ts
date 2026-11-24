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

describe("Spir engine batches (one visit per batch, for free plans)", () => {
  it("hands over a batch within the cap and quiet hours, and takes its reports in one go", async () => {
    const t = await setup([]);
    try {
      const s = t.scrapers;
      // 12:00 UTC is 15:00 in Baghdad; quiet hours start at 15:05 local.
      await s.saveEngineSettings({
        intervalSec: 60,
        jitterSec: 0,
        batchMinutes: 10,
        dailyCap: 100,
        quietFrom: 0,
        quietTo: 0,
      });
      const p = await s.createProject({ name: "p", owner: "o" });
      const seeds = Array.from({ length: 30 }, (_, i) => `acc${i}`);
      await s.createEngineRun({ name: "r", projectId: p.id, seeds, maxDepth: 0, maxAccounts: 100 });
      const w = { id: "pc-1", kind: "program" as const, batch: true, configVersion: null };
      const now = new Date("2030-01-01T12:00:00Z");

      const d = await s.engineNext(now, w);
      expect(d.action).toBe("batch");
      const items = d.action === "batch" ? d.items : [];
      expect(items).toHaveLength(10);
      expect(d).toMatchObject({ intervalSec: 60, jitterSec: 0 });
      // Asking again during the batch: wait until it is read.
      const early = await s.engineNext(new Date(now.getTime() + 60_000), w);
      expect(early).toMatchObject({ action: "wait", reason: "pace" });
      expect((early as { seconds: number }).seconds).toBeGreaterThan(8 * 60);

      // Five read, then Instagram refused, and the rest handed back.
      const reports = items.map((it, i) =>
        i < 5
          ? ({ itemId: it.id, status: "not_found" } as const)
          : i === 5
            ? ({ itemId: it.id, status: "rate_limited", message: "429" } as const)
            : ({ itemId: it.id, status: "released" } as const),
      );
      const after = await s.engineReport(reports, new Date(now.getTime() + 6 * 60_000), w);
      expect(after).toMatchObject({ action: "wait", reason: "resting" });
      const detail = await s.engineRun((await s.listEngineRuns())[0]?.id as string);
      expect(detail?.queue).toMatchObject({ done: 5, queued: 25 });

      // The cap limits a batch, and so do quiet hours.
      await s.clearEngineRest();
      await s.saveEngineSettings({ dailyCap: 8 });
      const later = new Date(now.getTime() + 3 * 3600_000);
      const capped = await s.engineNext(later, w);
      expect(capped.action === "batch" && capped.items.length).toBe(3);
      // Quiet hours from 20:00 Baghdad (17:00 UTC): five minutes before, a short batch only.
      await s.saveEngineSettings({ dailyCap: 100, quietFrom: 20, quietTo: 21 });
      const short = await s.engineNext(new Date("2030-01-01T16:55:00Z"), { ...w, id: "pc-2" });
      expect(short.action).toBe("batch");
      expect(short.action === "batch" ? short.items.length : 0).toBeLessThanOrEqual(5);
      // An older worker that cannot take batches still gets one account.
      await s.saveEngineSettings({ quietFrom: 0, quietTo: 0 });
      const single = await s.engineNext(new Date("2030-01-02T12:00:00Z"), {
        id: "old",
        kind: "program",
      });
      expect(single.action).toBe("read");
    } finally {
      await t.close();
    }
  });
});

describe("the engine reads ordinary jobs for free", () => {
  it("sends uncached accounts of a job to the engine and the cached ones straight to leads", async () => {
    const paid = new FakeProvider(
      "apify",
      ["profile"],
      {
        profile: () => {
          throw new Error("paid read");
        },
      },
      6000,
      2.5,
    );
    const t = await setup([paid]);
    try {
      const s = t.scrapers;
      const p = await s.createProject({ name: "p", owner: "o" });
      // No device yet: auto reads through the providers.
      expect(await s.engineOnline()).toBe(false);
      const auto = await s.startJob({
        projectId: p.id,
        source: { type: "upload", usernames: ["x1"], url: "list" },
        limit: 5,
        readVia: "auto",
      });
      expect(auto.readVia).toBe("providers");
      // A device checks in: auto now reads through the engine, and costs nothing.
      await s.engineNext(new Date(), { id: "pc", kind: "program" });
      expect(await s.engineOnline()).toBe(true);
      const { job, readVia, estimatedCostUsd } = await s.startJob({
        projectId: p.id,
        source: { type: "upload", usernames: ["u1", "u2", "u3"], url: "list" },
        limit: 10,
        readVia: "auto",
      });
      expect(readVia).toBe("engine");
      expect(estimatedCostUsd).toBe(0);
      await s.handlers.discover({ jobId: job.id, usernames: ["u1", "u2", "u3"] });
      const done = await s.getJob(job.id);
      expect(done.counts).toMatchObject({ viaEngine: 3, discovered: 0 });
      expect(done.status).toBe("done");
      const runs = await s.listEngineRuns();
      expect(runs[0]).toMatchObject({ maxDepth: 0, maxAccounts: 3 });
      expect(runs[0]?.seeds.sort()).toEqual(["u1", "u2", "u3"]);
      expect(paid.calls).toBe(0);
    } finally {
      await t.close();
    }
  });
});
