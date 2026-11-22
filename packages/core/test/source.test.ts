import { describe, expect, it } from "vitest";
import {
  isValidUsername,
  parseSource,
  parseUsernameCsv,
  SourceError,
  uploadSource,
} from "../src/source.js";
import { normalizeForSuppression, suppressionHash } from "../src/suppression.js";

describe("parseSource", () => {
  it.each([
    ["https://www.instagram.com/Competitor/", { type: "profile", username: "competitor" }],
    ["instagram.com/competitor?igsh=abc", { type: "profile", username: "competitor" }],
    ["@competitor", { type: "profile", username: "competitor" }],
    ["competitor.fx", { type: "profile", username: "competitor.fx" }],
    ["https://www.instagram.com/p/C1a2B3/", { type: "post", shortcode: "C1a2B3" }],
    ["https://instagram.com/reel/XyZ/?utm=1", { type: "post", shortcode: "XyZ" }],
    ["https://www.instagram.com/someone/p/AbC/", { type: "post", shortcode: "AbC" }],
    ["https://www.instagram.com/explore/tags/forex/", { type: "hashtag", tag: "forex" }],
    ["#تداول", { type: "hashtag", tag: "تداول" }],
  ])("%s", (input, expected) => {
    expect(parseSource(input)).toMatchObject(expected);
  });

  it("reads a followers list from its link or when asked for followers", () => {
    const expected = {
      type: "followers",
      username: "competitor",
      url: "https://www.instagram.com/competitor/followers/",
    };
    expect(parseSource("https://www.instagram.com/Competitor/followers/")).toEqual(expected);
    expect(parseSource("@competitor", "followers")).toEqual(expected);
    expect(parseSource("https://instagram.com/competitor", "followers")).toEqual(expected);
    // A plain profile is still the commenters of its posts.
    expect(parseSource("@competitor")).toMatchObject({ type: "profile" });
  });

  it("treats a bare word as a hashtag when asked to", () => {
    expect(parseSource("forex", "hashtag")).toMatchObject({ type: "hashtag", tag: "forex" });
  });

  it.each([
    "",
    "https://evil.com/instagram.com/x",
    "http://169.254.169.254/latest",
    "ftp://instagram.com/x",
    "https://www.instagram.com/explore/",
    "https://www.instagram.com/",
    "bad user!",
    "#",
    "http://[::1",
  ])("rejects %s", (input) => {
    expect(() => parseSource(input)).toThrow(SourceError);
  });

  it("validates usernames", () => {
    expect(isValidUsername("a.b_c1")).toBe(true);
    expect(isValidUsername(".ab")).toBe(false);
    expect(isValidUsername("a..b")).toBe(false);
    expect(isValidUsername("x".repeat(31))).toBe(false);
  });
});

describe("parseUsernameCsv", () => {
  it("uses a named column and normalises entries", () => {
    const csv =
      "﻿name,username\nAli,@Ali.FX\nSara,https://instagram.com/sara_trades/\nBad,not valid!\nDup,ali.fx\n";
    expect(parseUsernameCsv(csv)).toEqual(["ali.fx", "sara_trades"]);
  });

  it("accepts Arabic headers", () => {
    expect(parseUsernameCsv("الاسم,المعرف\nعلي,ali\n")).toEqual(["ali"]);
  });

  it("falls back to the first column without a header", () => {
    expect(parseUsernameCsv("ali\nsara\n\n")).toEqual(["ali", "sara"]);
  });

  it("stops at the limit and handles empty input", () => {
    expect(parseUsernameCsv("a\nb\nc", 2)).toEqual(["a", "b"]);
    expect(parseUsernameCsv("")).toEqual([]);
  });

  it("builds an upload source", () => {
    expect(uploadSource(["a"])).toEqual({ type: "upload", usernames: ["a"], url: "upload.csv" });
  });
});

describe("suppression", () => {
  it("normalises before hashing so variants collide", () => {
    const pepper = "p";
    expect(suppressionHash("username", "@Ali", pepper)).toBe(
      suppressionHash("username", "ali", pepper),
    );
    expect(suppressionHash("email", " A@B.com", pepper)).toBe(
      suppressionHash("email", "a@b.com", pepper),
    );
    expect(suppressionHash("phone", "00966 50 123 4567", pepper)).toBe(
      suppressionHash("phone", "+966501234567", pepper),
    );
    expect(suppressionHash("phone", "+٩٦٦٥٠١٢٣٤٥٦٧", pepper)).toBe(
      suppressionHash("phone", "+966501234567", pepper),
    );
  });

  it("keeps unparseable phones as digits", () => {
    expect(normalizeForSuppression("phone", "12-34")).toBe("1234");
  });

  it("differs by kind and pepper, and requires a pepper", () => {
    expect(suppressionHash("username", "a", "p")).not.toBe(suppressionHash("email", "a", "p"));
    expect(suppressionHash("username", "a", "p")).not.toBe(suppressionHash("username", "a", "q"));
    expect(() => suppressionHash("username", "a", "")).toThrow();
  });
});
