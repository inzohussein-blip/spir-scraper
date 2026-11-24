import { describe, expect, it } from "vitest";
import { TOOL_ACTORS } from "../src/pipeline/features/tools.js";
import {
  adLibraryUrl,
  STORE_TOOLS,
  storeTool,
  tiktokVideoUrl,
  youtubeVideoId,
} from "../src/store.js";
import { setup } from "./helpers.js";

describe("store catalog", () => {
  it("has unique ids, and every tool run has a mapped service", () => {
    const ids = STORE_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of STORE_TOOLS.filter((x) => x.run.kind === "tool"))
      expect(["youtube-comments", ...Object.keys(TOOL_ACTORS)]).toContain(t.id);
    expect(storeTool("fb-ads")?.pricing.per1k).toBe(0.75);
  });

  it("reads video links and builds the Ad Library address", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("not a link")).toBeNull();
    expect(tiktokVideoUrl("https://www.tiktok.com/@coach/video/7300000000000000000?lang=ar")).toBe(
      "https://www.tiktok.com/@coach/video/7300000000000000000",
    );
    expect(tiktokVideoUrl("https://www.tiktok.com/@coach")).toBeNull();
    const u = new URL(adLibraryUrl("تداول", "sa"));
    expect(u.searchParams.get("q")).toBe("تداول");
    expect(u.searchParams.get("country")).toBe("SA");
    expect(adLibraryUrl("https://www.facebook.com/SomeBroker", "ALL")).toBe(
      "https://www.facebook.com/SomeBroker",
    );
  });
});

describe("tool runs", () => {
  it("keeps YouTube comments as a dataset with the interested ones first", async () => {
    const t = await setup([], undefined, {
      tools: {
        youtubeComments: async (id, max) => {
          expect(id).toBe("dQw4w9WgXcQ");
          return [
            { id: "c1", author: "A", authorUrl: null, text: "فيديو جميل", likes: 3, at: null },
            {
              id: "c2",
              author: "B",
              authorUrl: "http://yt/b",
              text: "كيف أبدأ؟ ابي التفاصيل",
              likes: 1,
              at: "2026-11-01T00:00:00Z",
            },
            { id: "c2", author: "B", authorUrl: null, text: "duplicate", likes: 0, at: null },
          ].slice(0, max);
        },
      },
    });
    try {
      const run = await t.scrapers.runTool({
        tool: "youtube-comments",
        query: "https://youtu.be/dQw4w9WgXcQ",
        limit: 10,
      });
      expect(run.status).toBe("done");
      expect(run.items).toBe(2);
      expect(run.flagged).toBe(1);
      expect(Number(run.costUsd)).toBe(0);
      const items = await t.scrapers.toolRunItems(run.id);
      expect(items[0]?.key).toBe("c2");
      expect(items[0]?.data.intent).toEqual(expect.arrayContaining(["ابي"]));
      expect((await t.scrapers.toolRunItems(run.id, { flaggedOnly: true })).length).toBe(1);
      expect((await t.scrapers.listToolRuns({ tool: "youtube-comments" })).length).toBe(1);
    } finally {
      await t.close();
    }
  });

  it("runs the Ad Library and TikTok Actors through Apify and keeps failures with a reason", async () => {
    const calls: { actor: string; input: Record<string, unknown> }[] = [];
    const t = await setup([], undefined, {
      tools: {
        apifyActor: async (actor, input) => {
          calls.push({ actor, input: input as Record<string, unknown> });
          if (actor === TOOL_ACTORS["fb-ads"])
            return [
              {
                ad_archive_id: "111",
                page_name: "وسيط",
                page_id: "55",
                is_active: true,
                start_date: 1762000000,
                publisher_platform: ["FACEBOOK", "INSTAGRAM"],
                snapshot: {
                  body: { text: "افتح حسابك اليوم" },
                  link_url: "https://broker.example",
                },
              },
              { nothing: true },
            ];
          return [
            {
              cid: "9",
              text: "بكم الاشتراك؟",
              uniqueId: "fan1",
              diggCount: 4,
              videoWebUrl: "https://www.tiktok.com/@c/video/1",
            },
          ];
        },
      },
    });
    try {
      const ads = await t.scrapers.runTool({
        tool: "fb-ads",
        query: "تداول",
        country: "AE",
        limit: 50,
      });
      expect(ads.status).toBe("done");
      expect(ads.items).toBe(1);
      // 1 ad at $0.75 per 1,000, kept to 4 decimals.
      expect(Number(ads.costUsd)).toBeCloseTo(0.0008, 4);
      const fb = calls[0];
      expect(fb?.input.count).toBe(50);
      const urls = (fb?.input.urls ?? []) as { url: string }[];
      expect(String(urls[0]?.url)).toContain("country=AE");
      const [ad] = await t.scrapers.toolRunItems(ads.id);
      expect(ad?.data).toMatchObject({
        page: "وسيط",
        active: true,
        link: "https://broker.example",
      });

      const tk = await t.scrapers.runTool({
        tool: "tiktok-comments",
        query: "https://www.tiktok.com/@c/video/1",
      });
      expect(tk.flagged).toBe(1);
      const [c] = await t.scrapers.toolRunItems(tk.id);
      expect(c?.data.authorUrl).toBe("https://www.tiktok.com/@fan1");

      const bad = await t.scrapers.runTool({ tool: "tiktok-comments", query: "not a link" });
      expect(bad.status).toBe("failed");
      expect(bad.error).toContain("تيك توك");
      await expect(t.scrapers.runTool({ tool: "ig-followers", query: "x" })).rejects.toThrow();
    } finally {
      await t.close();
    }
  });

  it("says what is missing when a service is not set up", async () => {
    const t = await setup([]);
    try {
      expect(t.scrapers.toolAvailability()["youtube-comments"]).toBe(false);
      const r = await t.scrapers.runTool({ tool: "youtube-comments", query: "dQw4w9WgXcQ" });
      expect(r.status).toBe("failed");
      expect(r.error).toContain("YOUTUBE_API_KEY");
    } finally {
      await t.close();
    }
  });
});
