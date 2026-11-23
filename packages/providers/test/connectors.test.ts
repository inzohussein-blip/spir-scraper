import { AccountNotFoundError } from "@scrapers/core";
import { describe, expect, it } from "vitest";
import { connectorsFromEnv, TelegramConnector, YouTubeConnector } from "../src/index.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("YouTube connector", () => {
  it("reads a channel by handle or id", async () => {
    const urls: string[] = [];
    const yt = new YouTubeConnector("k", async (url) => {
      urls.push(url);
      return json({
        items: [
          {
            id: "UCabcdefghijklmnopqrstuv",
            snippet: { title: "FX Arab", description: "تداول الذهب", country: "SA" },
            statistics: { subscriberCount: "15400", videoCount: "210", viewCount: "990000" },
          },
        ],
      });
    });
    expect(await yt.getAccount("FxArab")).toEqual({
      displayName: "FX Arab",
      bio: "تداول الذهب",
      followers: 15400,
      stats: { channelId: "UCabcdefghijklmnopqrstuv", videos: 210, views: 990000, country: "SA" },
    });
    expect(urls[0]).toContain("forHandle=%40FxArab");
    expect(urls[0]).toContain("key=k");
    await yt.getAccount("UCabcdefghijklmnopqrstuv");
    expect(urls[1]).toContain("id=UCabcdefghijklmnopqrstuv");
  });

  it("reports missing channels and API errors", async () => {
    await expect(
      new YouTubeConnector("k", async () => json({ items: [] })).getAccount("x"),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
    await expect(
      new YouTubeConnector("k", async () => json({ error: "quota" }, 403)).getAccount("x"),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe("Telegram connector", () => {
  it("reads a public channel's title, description and members", async () => {
    const calls: { url: string; body: string }[] = [];
    const tg = new TelegramConnector("T", async (url, init) => {
      calls.push({ url, body: String(init?.body) });
      return url.endsWith("/getChat")
        ? json({
            ok: true,
            result: { title: "إشارات الذهب", description: "توصيات", type: "channel" },
          })
        : json({ ok: true, result: 8200 });
    });
    expect(await tg.getAccount("gold_signals")).toEqual({
      displayName: "إشارات الذهب",
      bio: "توصيات",
      followers: 8200,
      stats: { type: "channel" },
    });
    expect(calls[0]?.url).toBe("https://api.telegram.org/botT/getChat");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ chat_id: "@gold_signals" });
  });

  it("treats unknown and private chats as not found", async () => {
    const tg = new TelegramConnector("T", async () =>
      json({ ok: false, description: "Bad Request: chat not found" }, 400),
    );
    await expect(tg.getAccount("nope")).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it("is configured from the environment", () => {
    expect(connectorsFromEnv({}).map((c) => c.platform)).toEqual(["website"]);
    expect(connectorsFromEnv({ WEBSITE_READER: "off" }).map((c) => c.platform)).toEqual([]);
    expect(
      connectorsFromEnv({ YOUTUBE_API_KEY: "a", TELEGRAM_BOT_TOKEN: "b" }).map((c) => c.platform),
    ).toEqual(["youtube", "telegram", "website"]);
    const withApify = connectorsFromEnv({ APIFY_TOKEN: "t" });
    expect(withApify.map((c) => [c.platform, !!c.paid])).toEqual([
      ["tiktok", true],
      ["website", false],
    ]);
  });
});
