/** Default seconds a drain may run inside one function call (DRAIN_BUDGET_SECONDS overrides). */
export const DEFAULT_DRAIN_SECONDS = 240;

/**
 * Time left for one job to overrun the budget (a drain checks the clock only
 * between jobs; one Apify call can take ~20 s) and for the hand-off request.
 */
export const DRAIN_MARGIN_SECONDS = 25;

/**
 * How long a drain started by a route may run. It must end before the route's
 * own time limit (maxDuration), or Vercel stops the function mid-job and the
 * hand-off to a fresh call never happens, leaving the job stalled.
 */
export function drainBudgetMs(
  routeMaxSeconds: number,
  configuredSeconds: number = DEFAULT_DRAIN_SECONDS,
): number {
  const fit = Math.max(5, routeMaxSeconds - DRAIN_MARGIN_SECONDS);
  return Math.min(configuredSeconds, fit) * 1000;
}
