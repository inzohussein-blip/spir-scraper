/**
 * Splits next month's collection budget across sources by what they earned.
 * A source's close rate is estimated with a Beta prior, so 1 deal out of 2
 * attempts is not treated like 10 out of 20. Most of the budget goes to the
 * best expected value (exploit); a share is kept for sources with too little
 * data (explore), so a good new source can prove itself.
 */

export interface SourceStats {
  source: string;
  leads: number;
  reached: number;
  customers: number;
  revenue: number;
  costUsd: number;
}

export type BudgetDecision = "increase" | "keep" | "decrease" | "stop" | "explore";

export interface BudgetLine {
  source: string;
  decision: BudgetDecision;
  /** Expected revenue per account collected (prior-smoothed). */
  valuePerAccount: number;
  /** USD allocated for the next period. */
  usd: number;
  /** Accounts that budget buys at costPerAccount. */
  accounts: number;
  /** Arabic reason. */
  reason: string;
}

export const DECISION_LABELS: Record<BudgetDecision, string> = {
  increase: "زِد",
  keep: "استمر",
  decrease: "خفّض",
  stop: "أوقف",
  explore: "جرّب",
};

export function planBudget(
  sources: SourceStats[],
  opts: {
    budgetUsd: number;
    /** USD to collect one account (discovery + profile). */
    costPerAccount: number;
    exploreShare?: number;
    /** Reached accounts below which a source is still "exploring". */
    minReached?: number;
  },
): { lines: BudgetLine[]; exploitUsd: number; exploreUsd: number; avgDeal: number } {
  const minReached = opts.minReached ?? 20;
  const exploreShare = opts.exploreShare ?? 0.2;
  const totalCustomers = sources.reduce((s, x) => s + x.customers, 0);
  const totalRevenue = sources.reduce((s, x) => s + x.revenue, 0);
  // Without recorded deal values, every customer counts as 1 so sources still rank.
  const avgDeal = totalCustomers > 0 && totalRevenue > 0 ? totalRevenue / totalCustomers : 1;
  const totalReached = sources.reduce((s, x) => s + x.reached, 0);
  const prior = totalReached > 0 ? Math.max(totalCustomers / totalReached, 0.01) : 0.05;
  const strength = 10;

  const rated = sources.map((s) => {
    const rate = (s.customers + prior * strength) / (s.reached + strength);
    // Share of collected accounts that are reached is what turns leads into deals.
    const reachShare = s.leads > 0 ? Math.min(1, s.reached / s.leads) : 0.3;
    const valuePerAccount = rate * Math.max(reachShare, 0.1) * avgDeal;
    return { s, rate, valuePerAccount };
  });

  const proven = rated.filter((r) => r.s.reached >= minReached);
  const exploring = rated.filter((r) => r.s.reached < minReached);
  const losing = proven.filter((r) => r.s.customers === 0);
  const winning = proven.filter((r) => r.s.customers > 0);

  const exploreUsd = exploring.length ? opts.budgetUsd * exploreShare : 0;
  const exploitUsd = opts.budgetUsd - exploreUsd;
  const totalValue = winning.reduce((s, r) => s + r.valuePerAccount, 0);
  const values = winning.map((r) => r.valuePerAccount).sort((x, y) => x - y);
  const mid = Math.floor(values.length / 2);
  const median =
    values.length === 0
      ? 0
      : values.length % 2
        ? (values[mid] as number)
        : ((values[mid - 1] as number) + (values[mid] as number)) / 2;

  const lines: BudgetLine[] = [];
  for (const r of winning) {
    const usd = totalValue > 0 ? (exploitUsd * r.valuePerAccount) / totalValue : 0;
    const decision: BudgetDecision =
      winning.length === 1 || r.valuePerAccount >= median * 1.25
        ? "increase"
        : r.valuePerAccount >= median * 0.75
          ? "keep"
          : "decrease";
    lines.push({
      source: r.s.source,
      decision,
      valuePerAccount: Math.round(r.valuePerAccount * 100) / 100,
      usd: Math.round(usd * 100) / 100,
      accounts: Math.floor(usd / opts.costPerAccount),
      reason: `${r.s.customers} عميل من ${r.s.reached} تواصلت معهم`,
    });
  }
  for (const r of losing)
    lines.push({
      source: r.s.source,
      decision: "stop",
      valuePerAccount: Math.round(r.valuePerAccount * 100) / 100,
      usd: 0,
      accounts: 0,
      reason: `تواصلت مع ${r.s.reached} بلا أي عميل`,
    });
  // With no winner yet, the exploit share also goes to exploring.
  const exploreTotal = exploreUsd + (winning.length === 0 ? exploitUsd : 0);
  for (const r of exploring) {
    const usd = exploring.length ? exploreTotal / exploring.length : 0;
    lines.push({
      source: r.s.source,
      decision: "explore",
      valuePerAccount: Math.round(r.valuePerAccount * 100) / 100,
      usd: Math.round(usd * 100) / 100,
      accounts: Math.floor(usd / opts.costPerAccount),
      reason: `بيانات قليلة (${r.s.reached} تواصل فقط): نعطيه فرصة`,
    });
  }
  const order: BudgetDecision[] = ["increase", "keep", "decrease", "explore", "stop"];
  lines.sort((a, b) => order.indexOf(a.decision) - order.indexOf(b.decision) || b.usd - a.usd);
  return {
    lines,
    exploitUsd: Math.round((winning.length ? exploitUsd : 0) * 100) / 100,
    exploreUsd: Math.round(exploreTotal * 100) / 100,
    avgDeal: Math.round(avgDeal * 100) / 100,
  };
}
