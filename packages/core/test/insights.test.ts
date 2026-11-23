import { describe, expect, it } from "vitest";
import { analyzePosts, detectLanguage, growthPercent, profileChanges } from "../src/index.js";

describe("detectLanguage", () => {
  it("tells Arabic, Persian, English, Turkish and Russian apart", () => {
    expect(detectLanguage("وسيط تداول معتمد في الكويت")).toBe("ar");
    expect(detectLanguage("آموزش ترید و سرمایه گذاری پچ")).toBe("fa");
    expect(detectLanguage("Forex trader and mentor")).toBe("en");
    expect(detectLanguage("Yatırım danışmanı, güvenilir işlem")).toBe("tr");
    expect(detectLanguage("Трейдер и инвестор")).toBe("ru");
  });

  it("ignores links, handles and hashtags, and returns null without text", () => {
    expect(detectLanguage("https://example.com @abc #forex")).toBeNull();
    expect(detectLanguage(null)).toBeNull();
    expect(detectLanguage("مدرب تداول https://example.com/learn-more-now")).toBe("ar");
  });
});

describe("profileChanges", () => {
  const base = { isBusiness: false, bio: "hello" };
  it("reports new contacts and a switch to a business account", () => {
    expect(
      profileChanges(base, {
        isBusiness: true,
        bio: "hello",
        businessEmail: "a@b.co",
        businessPhone: "+96550000000",
      }),
    ).toEqual(["أضاف إيميلاً", "أضاف رقماً", "صار حساباً تجارياً"]);
  });
  it("reports nothing when nothing that matters changed", () => {
    expect(profileChanges(base, { ...base })).toEqual([]);
  });
});

describe("analyzePosts", () => {
  const posts = [
    // Fri 2026-11-20 18:00 Baghdad time = 15:00 UTC
    {
      likes: 900,
      comments: 100,
      type: "video",
      timestamp: "2026-11-20T15:00:00Z",
      caption: "Big win #forex #gold",
      url: "u1",
    },
    {
      likes: 90,
      comments: 10,
      type: "image",
      timestamp: "2026-11-18T07:00:00Z",
      caption: "#forex tips",
      url: "u2",
    },
    {
      likes: 400,
      comments: 50,
      type: "video",
      timestamp: "2026-11-16T15:30:00Z",
      caption: null,
      url: "u3",
    },
    { likes: null, comments: null },
  ];

  it("finds what performs best and when", () => {
    const a = analyzePosts(posts, 10_000, "Asia/Baghdad");
    expect(a.analysed).toBe(3);
    expect(a.avgInteractions).toBe(517);
    expect(a.engagementRate).toBe(5.167);
    expect(a.byType[0]).toEqual({ type: "video", posts: 2, avg: 725 });
    expect(a.bestHours[0]).toBe(18);
    expect(a.bestDays[0]).toBe(5);
    expect(a.topHashtags[0]).toEqual({ tag: "forex", count: 2 });
    expect(a.topPosts[0]?.url).toBe("u1");
    expect(a.postEveryDays).toBe(2);
  });

  it("copes with no posts", () => {
    expect(analyzePosts(null, 100).analysed).toBe(0);
    expect(analyzePosts([], null).engagementRate).toBeNull();
  });
});

describe("growthPercent", () => {
  it("returns the change as a percentage", () => {
    expect(growthPercent(1000, 1050)).toBe(5);
    expect(growthPercent(null, 10)).toBeNull();
    expect(growthPercent(1000, null)).toBeNull();
  });
});
