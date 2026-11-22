import { type Provider, RateLimitedError, uploadSource } from "@scrapers/core";
import { ApifyProvider } from "@scrapers/providers";
import { describe, expect, it } from "vitest";
import { TelegramNotifier } from "../src/index.js";
import { createTestRuntime, fakeProfile } from "../src/testing.js";

function telegramSpy() {
  const sent: { url: string; body: { chat_id: string; text: string; parse_mode: string } }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response("{}");
  };
  return { sent, fetch };
}

describe("TelegramNotifier", () => {
  it("formats notifications as escaped HTML with a dashboard link", async () => {
    const t = telegramSpy();
    await new TelegramNotifier("123:ABC", "42", t.fetch).send({
      type: "job",
      level: "ok",
      title: "انتهت <مهمة>",
      body: "a & b",
      link: "https://app/jobs/1",
    });
    expect(t.sent[0]?.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(t.sent[0]?.body).toMatchObject({ chat_id: "42", parse_mode: "HTML" });
    expect(t.sent[0]?.body.text).toBe(
      '✅ <b>انتهت &lt;مهمة&gt;</b>\na &amp; b\n<a href="https://app/jobs/1">فتح في اللوحة</a>',
    );
  });

  it("reports Telegram errors", async () => {
    const n = new TelegramNotifier("t", "1", async () => new Response("no", { status: 401 }));
    await expect(n.sendText("x")).rejects.toThrow(/HTTP 401/);
  });
});

describe("runtime notifications", () => {
  it("sends job and provider events to Telegram", async () => {
    const t = telegramSpy();
    let limited = true;
    const flaky: Provider = {
      id: "worker",
      capabilities: new Set(["profile"]),
      ratePerMinute: 1_000_000,
      getProfile: async (u) => {
        if (limited) throw new RateLimitedError("429 Too Many Requests", "worker");
        return fakeProfile(u);
      },
    };
    const rt = await createTestRuntime({
      providers: [flaky],
      env: { TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "9", APP_URL: "https://scrapers.app" },
      telegramFetch: t.fetch,
    });
    try {
      expect(rt.telegram).not.toBeNull();
      const p = await rt.scrapers.createProject({ name: "p", owner: rt.owner });
      await rt.scrapers.startJob({ projectId: p.id, source: uploadSource(["user2"]), limit: 1 });
      await rt.scrapers.drain({ budgetMs: 5_000 });
      await new Promise((r) => setTimeout(r, 50));
      const texts = t.sent.map((s) => s.body.text);
      expect(texts.some((x) => x.includes("المصدر worker: تجاوز حد الطلبات"))).toBe(true);
      // The account is deferred, not failed, and the link points at the dashboard.
      expect(
        texts.some(
          (x) => x.includes("أُجّل 1 حساباً في مهمة p") && x.includes("https://scrapers.app/jobs/"),
        ),
      ).toBe(true);
      limited = false;
      expect(await rt.healthCheck()).toEqual([
        { provider: "worker", ok: true, detail: "@instagram fetched" },
      ]);
    } finally {
      await rt.close();
    }
  });

  it("warns when the Apify credit is nearly used and when a canary fails", async () => {
    const apify = new ApifyProvider({
      token: "t",
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 4.8 } },
          }),
        ),
    });
    const broken: Provider = {
      id: "graph",
      capabilities: new Set(["profile"]),
      ratePerMinute: 60,
      getProfile: async () => {
        throw new Error("token expired");
      },
    };
    const rt = await createTestRuntime({ providers: [broken, apify] });
    try {
      const r = await rt.healthCheck();
      expect(r).toEqual([
        { provider: "graph", ok: false, detail: "token expired" },
        { provider: "apify", ok: false, detail: "$0.20 remaining this month" },
      ]);
      const titles = (await rt.scrapers.listNotifications()).map((n) => n.title);
      expect(titles).toEqual(
        expect.arrayContaining([
          "رصيد Apify قارب على النفاد",
          "الفحص اليومي: المصدر graph لا يعمل",
        ]),
      );
      expect(rt.telegram).toBeNull();
    } finally {
      await rt.close();
    }
  });
});
