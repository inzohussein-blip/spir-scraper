import { describe, expect, it } from "vitest";
import { planBudget } from "../src/index.js";

const s = (source: string, leads: number, reached: number, customers: number, revenue: number) => ({
  source,
  leads,
  reached,
  customers,
  revenue,
  costUsd: 1,
});

describe("budget plan", () => {
  it("backs the winners, stops the losers and keeps a share for new sources", () => {
    const plan = planBudget(
      [
        s("gold", 400, 80, 8, 4000),
        s("fx", 300, 60, 2, 1000),
        s("dead", 500, 50, 0, 0),
        s("new", 50, 5, 0, 0),
      ],
      { budgetUsd: 10, costPerAccount: 0.005 },
    );
    const by = (x: string) => plan.lines.find((l) => l.source === x);
    expect(by("gold")?.decision).toBe("increase");
    expect(by("fx")?.decision).toBe("decrease");
    expect(by("dead")).toMatchObject({ decision: "stop", usd: 0 });
    expect(by("new")).toMatchObject({ decision: "explore", usd: 2, accounts: 400 });
    expect((by("gold")?.usd ?? 0) > (by("fx")?.usd ?? 0)).toBe(true);
    expect(plan.exploitUsd + plan.exploreUsd).toBeCloseTo(10, 5);
    expect(plan.avgDeal).toBe(500);
    expect(plan.lines.map((l) => l.decision)).toEqual(["increase", "decrease", "explore", "stop"]);
  });

  it("does not overreact to one lucky deal", () => {
    const plan = planBudget([s("lucky", 10, 2, 1, 500), s("steady", 400, 100, 10, 5000)], {
      budgetUsd: 5,
      costPerAccount: 0.005,
    });
    // 1 of 2 is still exploring; the steady source gets the exploit share.
    expect(plan.lines.find((l) => l.source === "lucky")?.decision).toBe("explore");
    expect(plan.lines.find((l) => l.source === "steady")?.usd).toBe(4);
  });

  it("explores everything while nothing has proven itself", () => {
    const plan = planBudget([s("a", 20, 3, 0, 0), s("b", 20, 1, 0, 0)], {
      budgetUsd: 4,
      costPerAccount: 0.01,
    });
    expect(plan.lines.map((l) => [l.decision, l.usd])).toEqual([
      ["explore", 2],
      ["explore", 2],
    ]);
  });
});
