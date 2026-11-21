import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/notify.js";
import { ProviderRouter } from "../src/pipeline/router.js";
import { parseSource, uploadSource } from "../src/source.js";
import { BudgetExceededError, RateLimitedError } from "../src/types.js";
import { FakeProvider, fakeProfile, setup } from "./helpers.js";

describe("redactSecrets", () => {
  it("hides keys, tokens and credentials", () => {
    const line =
      "key sk_abcdefghijklmnop apify_api_ABCDEFGHIJKL Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXZhbHVl " +
      "123456789:AAEhBP0av28ijKLMNOPQRSTUVWXYZabcdefg postgres://user:pass@db:5432/x?token=abc";
    const out = redactSecrets(line);
    for (const secret of [
      "sk_abcdefghijklmnop",
      "apify_api_ABCDEFGHIJKL",
      "eyJhbGci",
      "AAEhBP0av28",
      "user:pass",
      "token=abc",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(redactSecrets("hello world")).toBe("hello world");
  });
});

describe("notifications", () => {
  it("stores, deduplicates, forwards and marks read", async () => {
    const sent: { title: string; link?: string }[] = [];
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const { createScrapers } = await import("../src/pipeline/service.js");
      const s = createScrapers({
        db: t.db,
        boss: t.boss,
        router: t.router,
        config: { suppressionPepper: "p" },
        appUrl: "https://app.example/",
        sinks: [{ send: async (n) => void sent.push(n) }],
      });
      expect(
        await s.notify({
          type: "system",
          level: "info",
          title: "hello sk_secretsecretsecret",
          url: "/x",
        }),
      ).toBe(true);
      expect(
        await s.notify({
          type: "system",
          level: "info",
          title: "hello sk_secretsecretsecret",
          url: "/x",
        }),
      ).toBe(false);
      expect(sent).toEqual([
        expect.objectContaining({ title: "hello sk_<redacted>", link: "https://app.example/x" }),
      ]);
      expect(await s.unreadNotifications()).toBe(1);
      await s.markNotificationsRead();
      expect(await s.unreadNotifications()).toBe(0);
      expect((await s.listNotifications())[0]?.readAt).toBeInstanceOf(Date);
    } finally {
      await t.close();
    }
  });

  it("notifies when a job finishes or fails", async () => {
    const t = await setup([new FakeProvider("worker", ["profile"], { profile: fakeProfile })]);
    try {
      const p = await t.scrapers.createProject({ name: "خليج", owner: "o" });
      const { job } = await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(["user1", "user2"]),
        limit: 5,
      });
      while ((await t.scrapers.drain({ budgetMs: 5000 })).activeJobs > 0);
      const { job: bad } = await t.scrapers.startJob({
        projectId: p.id,
        source: parseSource("#fx"),
        limit: 5,
      });
      await t.scrapers.drain({ budgetMs: 5000 });
      const list = await t.scrapers.listNotifications();
      expect(list.map((n) => [n.title, n.level, n.url])).toEqual([
        ["فشلت مهمة خليج", "bad", `/jobs/${bad.id}`],
        ["انتهت مهمة خليج", "ok", `/jobs/${job.id}`],
      ]);
      expect(list[1]?.body).toContain("مكتشفة 2");
    } finally {
      await t.close();
    }
  });
});

describe("activity log", () => {
  it("records actions with redacted details and counts failed logins", async () => {
    const t = await setup([]);
    try {
      await t.scrapers.audit({
        actor: "owner",
        action: "key.create",
        detail: { key: "sk_abcdefghijklmnopq" },
        ip: "1.1.1.1",
      });
      await t.scrapers.audit({ actor: "anon", action: "login.failed", ip: "1.1.1.1" });
      await t.scrapers.audit({ actor: "anon", action: "login.failed", ip: "2.2.2.2" });
      const all = await t.scrapers.listAudit();
      expect(all).toHaveLength(3);
      expect(
        JSON.stringify((await t.scrapers.listAudit({ action: "key.create" }))[0]?.detail),
      ).not.toContain("abcdefghij");
      expect(await t.scrapers.failedLogins("1.1.1.1")).toEqual({ ip: 1, all: 2 });
      expect(await t.scrapers.failedLogins(null)).toEqual({ ip: 0, all: 2 });
    } finally {
      await t.close();
    }
  });
});

describe("provider health events", () => {
  it("reports a provider going down once and coming back", async () => {
    const events: string[] = [];
    let fail: Error | null = new RateLimitedError("429", "worker");
    const p = new FakeProvider("worker", ["profile"], {
      profile: (u) => {
        if (fail) throw fail;
        return fakeProfile(u);
      },
    });
    let now = 0;
    const r = new ProviderRouter([p], {
      now: () => now,
      sleep: async () => {},
      cooldownMs: 10,
      onHealth: (e) => events.push(e.status === "down" ? `down:${e.reason}` : "up"),
    });
    await r.getProfile("a").catch(() => {});
    now = 20;
    await r.getProfile("a").catch(() => {});
    now = 40;
    fail = null;
    await r.getProfile("a");
    await r.getProfile("b");
    fail = new BudgetExceededError("credit", "worker");
    now = 60;
    await r.getProfile("c").catch(() => {});
    expect(events).toEqual(["down:rate_limited", "up", "down:budget"]);
  });
});
