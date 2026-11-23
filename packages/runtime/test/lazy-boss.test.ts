import { describe, expect, it } from "vitest";
import { lazyBoss } from "../src/index.js";

describe("lazy queue start (serverless)", () => {
  it("connects only on first use, creates queues once, and leaves events alone", async () => {
    const calls: string[] = [];
    const raw = {
      start: async () => {
        calls.push("start");
        return raw;
      },
      createQueue: async (name: string) => {
        calls.push(`create:${name}`);
      },
      send: async (name: string) => {
        calls.push(`send:${name}`);
        return "id1";
      },
      on: (event: string) => {
        calls.push(`on:${event}`);
        return raw;
      },
    };
    const lazy = lazyBoss(raw as never);
    lazy.ready(async () => {
      await (lazy.boss as unknown as typeof raw).createQueue("discover");
    });
    const boss = lazy.boss as unknown as typeof raw;

    boss.on("error");
    expect(calls).toEqual(["on:error"]);
    expect(lazy.started()).toBe(false);

    const [a, b] = await Promise.all([boss.send("discover"), boss.send("enrich")]);
    expect([a, b]).toEqual(["id1", "id1"]);
    expect(calls).toEqual(["on:error", "start", "create:discover", "send:discover", "send:enrich"]);
    expect(lazy.started()).toBe(true);

    await boss.send("x");
    expect(calls.filter((c) => c === "start")).toHaveLength(1);
  });
});
