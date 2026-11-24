import { describe, expect, it } from "vitest";
import { uploadSource } from "../src/source.js";
import { FakeProvider, fakeProfile, setup } from "./helpers.js";

describe("daily operations manager", () => {
  it("sends one morning message with who to contact, and its buttons act only when pressed", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const s = t.scrapers;
      const p = await s.createProject({ name: "مشروع", owner: "o" });
      const { job } = await s.startJob({
        projectId: p.id,
        source: uploadSource(["user4", "user8", "user1"]),
        limit: 10,
      });
      for (let i = 0; i < 20; i++) if ((await s.drain({ budgetMs: 5_000 })).activeJobs === 0) break;
      expect((await s.getJob(job.id)).status).toBe("done");
      await s.setLeadStatus({ projectId: p.id, username: "user1", status: "interested" });
      // An engine run waits, and no device has ever checked in.
      await s.createEngineRun({ name: "r", projectId: p.id, seeds: ["seed"], maxDepth: 0 });

      const now = new Date();
      const m = await s.dailyOps(now);
      expect(m?.html).toContain("عملاء جدد: 3");
      expect(m?.html).toContain("مهتمون: 1");
      expect(m?.html).toContain("لا يوجد جهاز متصل");
      expect(m?.html).toMatch(/@user(4|8)/);
      expect(m?.buttons.map((b) => b.data)).toEqual(
        expect.arrayContaining(["ops:contacts", "ops:engine:off"]),
      );
      // Once a day.
      expect(await s.dailyOps(now)).toBeNull();
      expect((await s.listNotifications()).map((n) => n.title)).toContain(
        "لا يوجد جهاز متصل بمحرك Spir",
      );

      const contacts = await s.opsAction("ops:contacts", "https://app.example");
      expect(contacts).toContain("https://app.example/leads/");
      expect(contacts).not.toContain("@user1"); // already interested
      expect(await s.opsAction("ops:engine:off")).toContain("أُوقف");
      expect((await s.engineSettings()).enabled).toBe(false);
      expect(await s.opsAction("ops:nope")).toBe("زر غير معروف");
    } finally {
      await t.close();
    }
  });
});
