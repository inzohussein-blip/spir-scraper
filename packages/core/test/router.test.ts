import { describe, expect, it } from "vitest";
import { NoProviderError, ProviderRouter } from "../src/pipeline/router.js";
import { parseSource, uploadSource } from "../src/source.js";
import { BlockedError, BudgetExceededError, NotFoundError } from "../src/types.js";
import { FakeProvider, fakeProfile } from "./helpers.js";

describe("ProviderRouter", () => {
  it("spaces calls according to ratePerMinute", async () => {
    let now = 0;
    const waits: number[] = [];
    const p = new FakeProvider("worker", ["profile"], { profile: fakeProfile }, 30);
    const r = new ProviderRouter([p], {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await r.getProfile("a");
    await r.getProfile("b");
    await r.getProfile("c");
    expect(waits).toEqual([2000, 2000]);
  });

  it("rests blocked providers until the cooldown passes", async () => {
    let now = 0;
    let blocked = true;
    const p = new FakeProvider("worker", ["profile"], {
      profile: (u) => {
        if (blocked) throw new BlockedError("login wall", "worker");
        return fakeProfile(u);
      },
    });
    const r = new ProviderRouter([p], { now: () => now, sleep: async () => {}, cooldownMs: 1000 });
    await expect(r.getProfile("a")).rejects.toThrow(NoProviderError);
    blocked = false;
    await expect(r.getProfile("a")).rejects.toThrow(/No provider/);
    now = 1001;
    await expect(r.getProfile("a")).resolves.toMatchObject({ provider: "worker" });
  });

  it("does not try other providers for a missing account", async () => {
    const a = new FakeProvider("worker", ["profile"], {
      profile: () => {
        throw new NotFoundError("missing", "worker");
      },
    });
    const b = new FakeProvider("apify", ["profile"], { profile: fakeProfile });
    await expect(
      new ProviderRouter([a, b], { sleep: async () => {} }).getProfile("x"),
    ).rejects.toThrow(NotFoundError);
    expect(b.calls).toBe(0);
  });

  it("moves discovery to the next provider when the budget runs out", async () => {
    const broke = new FakeProvider("apify", ["post_commenters"], {
      engagers: () => {
        throw new BudgetExceededError("free credit used", "apify");
      },
    });
    const other = new FakeProvider("graph", ["post_commenters"], {
      engagers: (n) => ["a", "b", "c"].slice(0, n),
    });
    const r = new ProviderRouter([broke, other], { sleep: async () => {} });
    await expect(
      r.listEngagers(parseSource("https://instagram.com/p/X/") as never, 2),
    ).resolves.toEqual({
      usernames: ["a", "b"],
      provider: "graph",
    });
  });

  it("reports discovery errors and estimates cost", async () => {
    const failing = new FakeProvider(
      "apify",
      ["hashtag_posters"],
      {
        engagers: () => {
          throw new Error("actor crashed");
        },
      },
      60,
      3,
    );
    const enrich = new FakeProvider("worker", ["profile"], { profile: fakeProfile }, 60, 1);
    const r = new ProviderRouter([failing, enrich], { sleep: async () => {} });
    expect(r.estimateCost(parseSource("#fx") as never, 500)).toBe(2);
    expect(r.estimateCost(uploadSource(["a"]), 500)).toBe(0.5);
    await expect(r.listEngagers(parseSource("#fx") as never, 5)).rejects.toThrow(/actor crashed/);
  });
});
