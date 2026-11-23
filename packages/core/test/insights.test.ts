import { describe, expect, it } from "vitest";
import {
  analyzePosts,
  assignPersona,
  detectLanguage,
  growthPercent,
  profileChanges,
  risingSignal,
  searchTextOf,
} from "../src/index.js";

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

describe("rising accounts and personas", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
  it("flags accounts growing fast while still reachable", () => {
    expect(
      risingSignal([
        { at: day(0), followers: 4000 },
        { at: day(30), followers: 5200 },
      ]),
    ).toEqual({ rising: true, percent: 30, days: 30 });
    // Too soon, too slow, or too big.
    expect(
      risingSignal([
        { at: day(0), followers: 4000 },
        { at: day(5), followers: 6000 },
      ]).rising,
    ).toBe(false);
    expect(
      risingSignal([
        { at: day(0), followers: 4000 },
        { at: day(30), followers: 4400 },
      ]).rising,
    ).toBe(false);
    expect(
      risingSignal([
        { at: day(0), followers: 900_000 },
        { at: day(30), followers: 1_200_000 },
      ]).rising,
    ).toBe(false);
    expect(risingSignal([{ at: day(0), followers: 10 }]).percent).toBeNull();
  });

  it("assigns the persona with the most matching words", () => {
    const personas = [
      { name: "مدربو الذهب", keywords: ["ذهب", "gold", "xauusd"] },
      { name: "مبتدئون", keywords: ["مبتدئ", "تعلم"] },
    ];
    expect(
      assignPersona(searchTextOf({ username: "x", bio: "توصيات GOLD و XAUUSD يومياً" }), personas),
    ).toBe("مدربو الذهب");
    expect(assignPersona("ابي اتعلم التداول كمبتدئ", personas)).toBe("مبتدئون");
    expect(assignPersona("مطعم", personas)).toBeNull();
    expect(searchTextOf({ username: "Ab", fullName: "أحمد", bio: "Hi\n there" })).toBe(
      "ab احمد hi there",
    );
  });
});
