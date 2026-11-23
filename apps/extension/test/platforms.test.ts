import { describe, expect, it } from "vitest";
import { otherAccountFromUrl } from "../src/page/platforms.js";

describe("account pages on other platforms", () => {
  it("knows account addresses and ignores the rest", () => {
    expect(otherAccountFromUrl("https://www.tiktok.com/@Gold.Coach?lang=ar")).toEqual({
      platform: "tiktok",
      handle: "gold.coach",
      url: "https://www.tiktok.com/@gold.coach",
    });
    expect(otherAccountFromUrl("https://www.youtube.com/@FxArab/videos")?.handle).toBe("fxarab");
    expect(otherAccountFromUrl("https://x.com/fx_ali/status/123")?.url).toBe(
      "https://x.com/fx_ali",
    );
    expect(otherAccountFromUrl("https://t.me/gold_signals")?.platform).toBe("telegram");
    expect(otherAccountFromUrl("https://www.linkedin.com/in/ali-fx/")?.platform).toBe("linkedin");
    expect(otherAccountFromUrl("https://x.com/home")).toBeNull();
    expect(otherAccountFromUrl("https://www.youtube.com/watch?v=1")).toBeNull();
    expect(otherAccountFromUrl("https://www.instagram.com/acme/")).toBeNull();
    expect(otherAccountFromUrl("nonsense")).toBeNull();
  });
});
