import { describe, expect, it } from "vitest";
import { linkedAccounts, parseAccountUrl } from "../src/index.js";

describe("accounts on other platforms", () => {
  it("reads account addresses and ignores posts and link pages", () => {
    expect(parseAccountUrl("https://www.tiktok.com/@Gold.Coach?lang=ar")).toEqual({
      platform: "tiktok",
      handle: "gold.coach",
      url: "https://www.tiktok.com/@gold.coach",
    });
    expect(parseAccountUrl("youtube.com/@FxArab")?.url).toBe("https://www.youtube.com/@fxarab");
    expect(parseAccountUrl("https://youtube.com/channel/UCabcdefghijklmnopqrstuv")).toMatchObject({
      platform: "youtube",
      handle: "UCabcdefghijklmnopqrstuv",
    });
    expect(parseAccountUrl("t.me/signals_gold")?.platform).toBe("telegram");
    expect(parseAccountUrl("https://t.me/+AbCdEf")).toBeNull();
    expect(parseAccountUrl("https://twitter.com/fx_ali")?.url).toBe("https://x.com/fx_ali");
    expect(parseAccountUrl("https://www.linkedin.com/in/ali-fx")?.platform).toBe("linkedin");
    expect(parseAccountUrl("https://www.youtube.com/watch?v=abc")).toBeNull();
    expect(parseAccountUrl("https://www.instagram.com/p/Cx12/")).toBeNull();
    expect(parseAccountUrl("https://linktr.ee/ali")).toBeNull();
    expect(parseAccountUrl("https://acme-fx.com/about")).toEqual({
      platform: "website",
      handle: "acme-fx.com",
      url: "https://acme-fx.com",
    });
    expect(parseAccountUrl("not a url")).toBeNull();
  });

  it("finds accounts in a bio, its link and labelled handles", () => {
    const found = linkedAccounts(
      "مدرب ذهب 📈 يوتيوب: @FxArab | تلكرام @gold_signals\nموقعنا acme-fx.com ✉️ info@acme-fx.com\nhttps://www.tiktok.com/@goldcoach",
      "https://t.me/gold_signals",
    );
    expect(found.map((a) => `${a.platform}:${a.handle}`).sort()).toEqual([
      "telegram:gold_signals",
      "tiktok:goldcoach",
      "website:acme-fx.com",
      "youtube:fxarab",
    ]);
    expect(linkedAccounts("just a bio", null)).toEqual([]);
    expect(linkedAccounts(null, "https://linktr.ee/x")).toEqual([]);
  });
});
