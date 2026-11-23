import { describe, expect, it } from "vitest";
import { auc, explainModel, type LeadFeatures, predictWin, trainModel } from "../src/index.js";

const base: LeadFeatures = {
  followers: 2000,
  engagementRate: 2,
  sourceCount: 1,
  isBusiness: false,
  hasEmail: false,
  hasPhone: false,
  aiScore: 50,
  arabic: true,
  rising: false,
  qualityFlags: 0,
};

/** Customers follow several competitors and have a phone; rejected ones do not. */
function sample(n: number) {
  const rows: { features: LeadFeatures; label: 0 | 1 }[] = [];
  for (let i = 0; i < n; i++) {
    const good = i % 3 === 0;
    rows.push({
      label: good ? 1 : 0,
      features: {
        ...base,
        followers: 500 + ((i * 37) % 5000),
        sourceCount: good ? 2 + (i % 3) : 1,
        hasPhone: good ? i % 5 !== 0 : i % 4 === 0,
        aiScore: 40 + ((i * 13) % 40),
      },
    });
  }
  return rows;
}

describe("own prediction model", () => {
  it("computes AUC", () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.5, 0.5], [1, 0])).toBe(0.5);
    expect(auc([0.5], [1])).toBeNull();
  });

  it("refuses to train on too little", () => {
    expect(trainModel(sample(10))).toBeNull();
    expect(trainModel(sample(60).map((r) => ({ ...r, label: 0 as const })))).toBeNull();
  });

  it("learns what the owner's customers have in common, and says how sure it is", () => {
    const m = trainModel(sample(90), new Date("2030-01-01T00:00:00Z"));
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.trainedOn).toEqual({ positives: 30, negatives: 60 });
    expect(m.auc).toBeGreaterThan(0.85);
    const many = predictWin(m, { ...base, sourceCount: 4, hasPhone: true });
    const one = predictWin(m, { ...base, sourceCount: 1, hasPhone: false });
    expect(many).toBeGreaterThan(70);
    expect(one).toBeLessThan(30);
    expect(explainModel(m, 1)[0]).toMatchObject({
      label: "عدد المنافسين الذين يتابعهم",
      effect: "up",
    });
  });
});
