/**
 * A small, explainable model trained on the owner's own outcomes: which
 * leads became customers and which were rejected. Logistic regression with
 * L2 regularisation, standardised features, and an honest k-fold AUC so the
 * owner knows whether to trust it.
 */

export interface LeadFeatures {
  followers: number | null;
  engagementRate: number | null;
  sourceCount: number;
  isBusiness: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  aiScore: number | null;
  arabic: boolean;
  rising: boolean;
  qualityFlags: number;
}

export const FEATURE_LABELS = [
  "حجم الجمهور",
  "التفاعل",
  "عدد المنافسين الذين يتابعهم",
  "حساب تجاري",
  "له إيميل",
  "له رقم",
  "درجة الذكاء الاصطناعي",
  "يكتب بالعربي",
  "ينمو بسرعة",
  "علامات حساب وهمي",
] as const;

/** Numbers the model reads, in the order of FEATURE_LABELS. */
export function featureVector(f: LeadFeatures): number[] {
  return [
    Math.log10(1 + Math.max(0, f.followers ?? 0)),
    Math.min(f.engagementRate ?? 0, 30),
    Math.min(f.sourceCount, 6),
    f.isBusiness ? 1 : 0,
    f.hasEmail ? 1 : 0,
    f.hasPhone ? 1 : 0,
    (f.aiScore ?? 50) / 100,
    f.arabic ? 1 : 0,
    f.rising ? 1 : 0,
    Math.min(f.qualityFlags, 4),
  ];
}

export interface TrainedModel {
  version: 1;
  weights: number[];
  bias: number;
  mean: number[];
  std: number[];
  /** Leads it learned from. */
  trainedOn: { positives: number; negatives: number };
  /** Cross-validated area under the ROC curve (0.5 = guessing, 1 = perfect). */
  auc: number | null;
  trainedAt: string;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function standardise(X: number[][]) {
  const d = X[0]?.length ?? 0;
  const mean = Array.from(
    { length: d },
    (_, j) => X.reduce((s, x) => s + (x[j] ?? 0), 0) / X.length,
  );
  const std = Array.from({ length: d }, (_, j) => {
    const v = X.reduce((s, x) => s + ((x[j] ?? 0) - (mean[j] ?? 0)) ** 2, 0) / X.length;
    return Math.sqrt(v) || 1;
  });
  return { mean, std };
}

/** Gradient descent on the regularised log-loss; positives are re-weighted when rare. */
function fit(X: number[][], y: number[], l2 = 0.05, iters = 600, rate = 0.3) {
  const d = X[0]?.length ?? 0;
  const w = new Array<number>(d).fill(0);
  let b = 0;
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  const wPos = pos > 0 ? y.length / (2 * pos) : 1;
  const wNeg = neg > 0 ? y.length / (2 * neg) : 1;
  for (let it = 0; it < iters; it++) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      const x = X[i] as number[];
      const yi = y[i] as number;
      const p = sigmoid(x.reduce((s, v, j) => s + v * (w[j] as number), b));
      const e = (p - yi) * (yi === 1 ? wPos : wNeg);
      for (let j = 0; j < d; j++) gw[j] = (gw[j] as number) + e * (x[j] as number);
      gb += e;
    }
    for (let j = 0; j < d; j++)
      w[j] = (w[j] as number) - rate * ((gw[j] as number) / X.length + l2 * (w[j] as number));
    b -= (rate * gb) / X.length;
  }
  return { w, b };
}

/** Area under the ROC curve: the chance a random positive scores above a random negative. */
export function auc(scores: number[], labels: number[]): number | null {
  const pos = scores.filter((_, i) => labels[i] === 1);
  const neg = scores.filter((_, i) => labels[i] === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return Math.round((wins / (pos.length * neg.length)) * 1000) / 1000;
}

export const MIN_POSITIVES = 5;
export const MIN_LABELLED = 20;

/**
 * Trains on labelled leads (1 = customer or interested, 0 = rejected).
 * Returns null when there is too little to learn from.
 */
export function trainModel(
  rows: { features: LeadFeatures; label: 0 | 1 }[],
  now = new Date(),
): TrainedModel | null {
  const pos = rows.filter((r) => r.label === 1).length;
  const neg = rows.length - pos;
  if (rows.length < MIN_LABELLED || pos < MIN_POSITIVES || neg < MIN_POSITIVES) return null;
  const raw = rows.map((r) => featureVector(r.features));
  const y = rows.map((r) => r.label);
  const { mean, std } = standardise(raw);
  const X = raw.map((x) => x.map((v, j) => (v - (mean[j] as number)) / (std[j] as number)));

  // k-fold estimate of how well it ranks leads it has not seen.
  const k = Math.min(5, Math.max(2, Math.floor(Math.min(pos, neg) / 2)));
  const order = rows.map((_, i) => i).sort((a, b) => ((a * 7919) % 104729) - ((b * 7919) % 104729));
  const held: number[] = new Array(rows.length).fill(0);
  for (let f = 0; f < k; f++) {
    const test = order.filter((_, i) => i % k === f);
    const train = order.filter((_, i) => i % k !== f);
    const m = fit(
      train.map((i) => X[i] as number[]),
      train.map((i) => y[i] as number),
    );
    for (const i of test)
      held[i] = sigmoid((X[i] as number[]).reduce((s, v, j) => s + v * (m.w[j] as number), m.b));
  }
  const full = fit(X, y);
  return {
    version: 1,
    weights: full.w.map((v) => Math.round(v * 10000) / 10000),
    bias: Math.round(full.b * 10000) / 10000,
    mean,
    std,
    trainedOn: { positives: pos, negatives: neg },
    auc: auc(held, y),
    trainedAt: now.toISOString(),
  };
}

/** Probability (0-100) that a lead becomes a customer, by the trained model. */
export function predictWin(model: TrainedModel, f: LeadFeatures): number {
  const x = featureVector(f).map((v, j) => (v - (model.mean[j] ?? 0)) / (model.std[j] ?? 1));
  return Math.round(
    sigmoid(x.reduce((s, v, j) => s + v * (model.weights[j] ?? 0), model.bias)) * 100,
  );
}

/** The features that push a lead up or down most, in Arabic, strongest first. */
export function explainModel(
  model: TrainedModel,
  top = 4,
): { label: string; effect: "up" | "down"; weight: number }[] {
  return model.weights
    .map((w, j) => ({
      label: FEATURE_LABELS[j] ?? `#${j}`,
      effect: w >= 0 ? ("up" as const) : ("down" as const),
      weight: w,
    }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, top);
}
