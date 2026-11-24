import { describe, expect, it } from "vitest";
import { awakeMinutes, monthFraction } from "../src/pipeline/features/usage.js";
import { uploadSource } from "../src/source.js";
import { FakeProvider, fakeProfile, setup } from "./helpers.js";

describe("usage monitoring", () => {
  it("estimates awake time from active 5-minute slots", () => {
    expect(awakeMinutes([])).toBe(0);
    // One request keeps the database up for its slot and the next.
    expect(awakeMinutes([10])).toBe(10);
    // Back-to-back slots overlap.
    expect(awakeMinutes([10, 11, 12])).toBe(20);
    expect(awakeMinutes([10, 20])).toBe(20);
    expect(monthFraction(new Date("2030-01-16T12:00:00Z"))).toBeCloseTo(0.5, 1);
  });

  it("counts requests by kind, estimates awake hours, measures storage and forecasts the month", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const s = t.scrapers;
      const now = new Date("2030-01-16T12:00:00Z");
      for (let i = 0; i < 3; i++) await s.recordUsage("dashboard", now);
      await s.recordUsage("engine", new Date(now.getTime() + 60 * 60_000));
      const r = await s.usageReport(now);
      expect(r.requests).toBe(4);
      expect(r.byCategory).toEqual([
        { category: "dashboard", requests: 3 },
        { category: "engine", requests: 1 },
      ]);
      expect(r.days).toEqual([{ day: "2030-01-16", requests: 4, awakeMinutes: 20 }]);
      expect(r.dbHours).toBeCloseTo(20 / 60);
      expect(r.storageBytes).toBeGreaterThan(0);
      expect(r.tables.length).toBeGreaterThan(0);
      expect(r.forecast.requests).toBeGreaterThan(7);

      // Limits are the owner's to correct; nonsense falls back to the default.
      expect((await s.saveUsageLimits({ dbHours: 100, requests: -5 })).dbHours).toBe(100);
      expect((await s.usageLimits()).requests).toBe(1_000_000);
    } finally {
      await t.close();
    }
  });

  it("gives the extension a compact lead index for its badge", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const s = t.scrapers;
      const p = await s.createProject({ name: "p", owner: "o" });
      await s.startJob({ projectId: p.id, source: uploadSource(["user1", "user2"]), limit: 5 });
      for (let i = 0; i < 10; i++) if ((await s.drain({ budgetMs: 5_000 })).activeJobs === 0) break;
      await s.setLeadStatus({ projectId: p.id, username: "user2", status: "interested" });
      const idx = await s.leadIndex(p.id);
      expect(idx.map((e) => [e[0], e[1]]).sort()).toEqual([
        ["user1", "new"],
        ["user2", "interested"],
      ]);
    } finally {
      await t.close();
    }
  });
});

describe("automatic saving", () => {
  it("makes the engine lighter and pauses paid monitors, and undoes it on request or in a new month", async () => {
    const t = await setup([
      new FakeProvider("apify", ["profile", "account_followers"], { profile: fakeProfile }),
    ]);
    try {
      const s = t.scrapers;
      const p = await s.createProject({ name: "p", owner: "o" });
      const { parseSource } = await import("../src/source.js");
      const m = await s.createMonitor({
        projectId: p.id,
        source: parseSource("https://instagram.com/rival", "followers") as never,
      });
      await s.saveEngineSettings({ batchMinutes: 45, quietFrom: 2, quietTo: 7 });
      const now = new Date("2030-01-20T03:00:00Z");

      expect(await s.applySaver([], now)).toBeNull();
      const on = await s.applySaver(["dbHours", "apify"], now);
      expect(on?.active).toBe(true);
      expect(on?.actions).toHaveLength(2);
      expect(await s.engineSettings()).toMatchObject({
        batchMinutes: 90,
        quietFrom: 2,
        quietTo: 10,
      });
      expect((await s.listMonitors()).find((x) => x.id === m.id)?.enabled).toBe(false);
      // Applied once: a second day changes nothing more.
      expect(await s.applySaver(["dbHours"], now)).toBeNull();

      await s.undoSaver();
      expect(await s.engineSettings()).toMatchObject({
        batchMinutes: 45,
        quietFrom: 2,
        quietTo: 7,
      });
      expect((await s.listMonitors()).find((x) => x.id === m.id)?.enabled).toBe(true);
      expect((await s.saverState()).active).toBe(false);

      // A new month undoes it before deciding again; switched off, it does nothing.
      await s.applySaver(["requests"], now);
      await s.applySaver([], new Date("2030-02-01T03:00:00Z"));
      expect((await s.engineSettings()).batchMinutes).toBe(45);
      await s.setSaverAuto(false);
      expect(await s.applySaver(["dbHours"], now)).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("slows the engine after rests and speeds it up after calm days", async () => {
    const t = await setup([]);
    try {
      const s = t.scrapers;
      await s.saveEngineSettings({ intervalSec: 60, quietFrom: 0, quietTo: 0 });
      const p = await s.createProject({ name: "p", owner: "o" });
      await s.createEngineRun({
        name: "r",
        projectId: p.id,
        seeds: ["a1", "a2", "a3"],
        maxDepth: 0,
      });
      const now = new Date("2030-01-01T12:00:00Z");
      // Two refusals in a day.
      for (let i = 0; i < 2; i++) {
        const d = await s.engineNext(new Date(now.getTime() + i * 3600_000));
        if (d.action === "read")
          await s.engineReport(
            { itemId: d.item.id, status: "rate_limited" },
            new Date(now.getTime() + i * 3600_000),
          );
        await s.clearEngineRest();
      }
      // The rest log is written with the database clock: tune at the real time.
      const slower = await s.tuneEnginePace(new Date());
      expect(slower).toMatchObject({ from: 60, to: 75 });
      // Calm, but not enough reading: no change.
      expect(await s.tuneEnginePace(new Date(Date.now() + 5 * 86_400_000))).toBeNull();
      await s.saveEngineSettings({ adaptive: false });
      expect(await s.tuneEnginePace(now)).toBeNull();
    } finally {
      await t.close();
    }
  });
});
