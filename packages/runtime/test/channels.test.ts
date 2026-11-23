import { describe, expect, it } from "vitest";
import { handleCallback, handleCommand, handleLink, WebPushSink } from "../src/index.js";
import { createTestRuntime, settle } from "../src/testing.js";

describe("Telegram commands", () => {
  it("runs jobs, reports status, lists the top leads and switches projects", async () => {
    const rt = await createTestRuntime();
    const started: string[] = [];
    try {
      const ctx = {
        scrapers: rt.scrapers,
        owner: rt.owner,
        appUrl: "https://app",
        onJobStarted: (id: string) => started.push(id),
      };
      const state: { project?: string } = {};
      expect(await handleCommand(ctx, "/help")).toContain("/run");
      expect(await handleCommand(ctx, "/run")).toContain("اكتب رابطاً");
      expect(await handleCommand(ctx, "/run https://evil.com/x")).toContain("⛔");
      const reply = await handleCommand(ctx, "/run @user2 @user3 @user4 2", state);
      expect(reply).toContain("بدأت المهمة في <b>تلكرام</b> (حتى 2 حساب");
      expect(reply).toContain('href="https://app/jobs/');
      expect(started).toHaveLength(1);
      await settle(rt);
      expect(await handleCommand(ctx, "/status")).toMatch(/✅ telegram\n {3}2\/2 · بوسيلة تواصل 1/);
      expect(await handleCommand(ctx, "/top 5", state)).toMatch(
        /1\. @user3\n2\. @user2 — hi@shop2\.com · \+9647701000002/,
      );
      expect(await handleCommand(ctx, "/stats")).toContain("العملاء: 2");
      expect(await handleCommand(ctx, "/project وكلاء", state)).toContain(
        "صار المشروع: <b>وكلاء</b>",
      );
      expect(state.project).toBe("وكلاء");
      expect(await handleCommand(ctx, "/top", state)).toContain("لا عملاء في <b>وكلاء</b>");
      expect(await handleCommand(ctx, "/project", state)).toContain("وكلاء");
      expect(await handleCommand(ctx, "/nope")).toContain("أمر غير معروف");
    } finally {
      await rt.close();
    }
  });
});

describe("links sent to the bot", () => {
  it("reads Instagram, other platforms and websites, with buttons and /link", async () => {
    const rt = await createTestRuntime();
    const started: string[] = [];
    try {
      const pages: string[] = [];
      const links = {
        ...rt.scrapers,
        peekAccount: async (url: string) => ({
          ref: { platform: "youtube" as const, handle: "fxarab", url },
          account: { displayName: "FX Arab", bio: "قناة تداول", followers: 15400 },
        }),
        readPage: async (url: string) => {
          pages.push(url);
          return {
            title: "Acme FX",
            description: "وسيط",
            emails: ["info@acme.example"],
            phones: [],
            accounts: [
              { platform: "instagram", handle: "acmefx", url: "https://www.instagram.com/acmefx/" },
            ],
          };
        },
      };
      const ctx = {
        scrapers: rt.scrapers,
        links,
        owner: rt.owner,
        appUrl: "https://app",
        onJobStarted: (id: string) => started.push(id),
      };
      const state: { project?: string; lastLink?: string } = {};

      const ig = await handleLink(ctx, "شوف هذا https://www.instagram.com/user2/", state);
      expect(ig?.html).toContain("غير محفوظ بعد");
      expect(ig?.buttons).toEqual([{ text: "احفظ في المشروع", data: "save:user2" }]);
      expect(await handleCallback(ctx, "save:user2", state)).toContain("بدأت");
      expect(started).toHaveLength(1);
      await settle(rt);
      expect((await handleLink(ctx, "instagram.com/user2", state))?.buttons?.[0]?.text).toBe(
        "حدّث بياناته",
      );

      const yt = await handleLink(ctx, "https://www.youtube.com/@FxArab", state);
      expect(yt?.html).toContain("FX Arab · 15,400");
      expect(state.lastLink).toBe("https://www.youtube.com/@fxarab");
      expect(await handleCommand(ctx, "/link @user2", state)).toContain(
        "رُبط https://www.youtube.com/@fxarab",
      );
      expect(state.lastLink).toBeUndefined();
      expect((await rt.scrapers.personAccounts("user2")).map((a) => a.handle)).toEqual(["fxarab"]);
      expect(await handleCommand(ctx, "/link @user2", state)).toContain("أرسل رابط الحساب أولاً");

      const site = await handleLink(ctx, "acme.example", state);
      expect(site?.html).toContain("info@acme.example");
      expect(site?.buttons).toEqual([{ text: "احفظ @acmefx", data: "save:acmefx" }]);
      expect(pages).toEqual(["acme.example"]);

      expect(await handleLink(ctx, "مرحبا", state)).toBeNull();
      expect(await handleCallback(ctx, "drop table", state)).toBe("زر غير معروف");
    } finally {
      await rt.close();
    }
  });
});

describe("WebPushSink", () => {
  it("pushes to every subscription and drops the ones the browser removed", async () => {
    const subs = [
      { endpoint: "https://push/1", p256dh: "k1", auth: "a1" },
      { endpoint: "https://push/gone", p256dh: "k2", auth: "a2" },
    ];
    const deleted: string[] = [];
    const sent: { endpoint: string; payload: string }[] = [];
    const sink = new WebPushSink(
      () => ({
        listPushSubscriptions: async () => subs,
        deletePushSubscription: async (e) => void deleted.push(e),
      }),
      { publicKey: "p", privateKey: "k", subject: "mailto:x@y.z" },
      (async (sub: { endpoint: string }, payload?: string | Buffer | null) => {
        if (sub.endpoint.endsWith("gone"))
          throw Object.assign(new Error("gone"), { statusCode: 410 });
        sent.push({ endpoint: sub.endpoint, payload: String(payload) });
        return { statusCode: 201 };
      }) as never,
    );
    await sink.send({ type: "job", level: "ok", title: "انتهت", body: "b", url: "/jobs/1" });
    expect(sent).toEqual([
      {
        endpoint: "https://push/1",
        payload: JSON.stringify({ title: "انتهت", body: "b", url: "/jobs/1", level: "ok" }),
      },
    ]);
    expect(deleted).toEqual(["https://push/gone"]);
  });

  it("stores subscriptions through the runtime", async () => {
    const rt = await createTestRuntime();
    try {
      await rt.scrapers.savePushSubscription({ endpoint: "https://e", p256dh: "a", auth: "b" });
      await rt.scrapers.savePushSubscription({ endpoint: "https://e", p256dh: "c", auth: "d" });
      expect(await rt.scrapers.listPushSubscriptions()).toMatchObject([
        { endpoint: "https://e", p256dh: "c" },
      ]);
      await rt.scrapers.deletePushSubscription("https://e");
      expect(await rt.scrapers.listPushSubscriptions()).toEqual([]);
      expect(rt.vapidPublicKey).toBeNull();
    } finally {
      await rt.close();
    }
  });
});
