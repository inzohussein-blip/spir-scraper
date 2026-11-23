import { escapeHtml } from "@scrapers/runtime";
import { buildBackup } from "@/lib/backup";
import { isCronRequest } from "@/lib/drain";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Vercel Cron (daily on the Hobby plan): retention, AI batch collection,
 * provider checks, due competitor monitors, competitor follower snapshots,
 * follow-up reminders, the weekly summary and backup, and a drain safety net.
 * Each step runs on its own: one failing step is reported and the rest still run.
 */
export async function GET(req: Request) {
  if (!isCronRequest(req)) return new Response("unauthorized", { status: 401 });
  const rt = await getRuntime();
  const failed: string[] = [];
  async function step<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      failed.push(`${name}: ${(err as Error).message}`);
      return fallback;
    }
  }

  await step("retention", () => rt.scrapers.handlers.retention(), undefined);
  const health = await step("health", () => rt.healthCheck(), []);
  const monitorJobs = await step("monitors", () => rt.scrapers.runDueMonitors(), [] as string[]);
  const competitors = await step("competitors", () => rt.scrapers.snapshotCompetitors(), null);
  const followUps = await step("follow-ups", () => rt.scrapers.sendDueFollowUps(), 0);
  const accountsRead = await step("accounts", () => rt.scrapers.refreshPendingAccounts(), 0);
  const placesRead = await step(
    "places",
    async () => {
      let n = 0;
      for (const p of await rt.scrapers.listProjects())
        n += (await rt.scrapers.analyzePlaces(p.id, 20)).analyzed;
      return n;
    },
    0,
  );
  const sites = await step("sites", () => rt.scrapers.checkSiteWatches(), null);
  const weekly = await step("weekly", () => rt.scrapers.weeklySummary(), null);
  // The weekly analyst: a plan per project, applied only when the owner approves it.
  const plans = weekly
    ? await step(
        "plans",
        async () => {
          const usage = await rt.apifyUsage().catch(() => null);
          const budget = usage ? Math.max(0, usage.allowedUsd - usage.usedUsd) : 5;
          const sent: string[] = [];
          for (const p of await rt.scrapers.listProjects()) {
            const plan = await rt.scrapers.weeklyPlan(p.id, budget);
            sent.push(plan.id);
            await rt.telegram?.sendText(
              escapeHtml(plan.text),
              plan.changes
                ? [{ text: "✅ وافق على تغييرات الميزانية", data: `plan:${plan.id}` }]
                : undefined,
            );
          }
          return sent;
        },
        [] as string[],
      )
    : [];
  let backupSent = false;
  if (weekly && rt.telegram) {
    // The weekly backup goes to the owner's Telegram chat: free and off-site.
    backupSent = await step(
      "backup",
      async () => {
        const b = await buildBackup(rt);
        await rt.telegram?.sendDocument(b.name, b.bytes, `نسخة احتياطية أسبوعية · ${b.summary}`);
        return true;
      },
      false,
    );
  }
  const drained = await step("drain", () => rt.scrapers.drain({ budgetMs: 150_000 }), null);
  await rt.scrapers.setValue("cron:last", new Date().toISOString(), 30 * 86_400_000);
  if (failed.length > 0)
    await rt.scrapers
      .notify({
        type: "system",
        level: "bad",
        title: `فشلت ${failed.length} من مهام الصيانة اليومية`,
        body: failed.join("\n").slice(0, 1500),
        url: "/settings",
        key: `cron-failed:${new Date().toISOString().slice(0, 10)}`,
      })
      .catch(() => {});
  return Response.json({
    ok: failed.length === 0,
    failed,
    ...(drained ?? {}),
    health,
    monitorJobs,
    competitors,
    followUps,
    accountsRead,
    placesRead,
    sites,
    weeklySent: !!weekly,
    plans,
    backupSent,
  });
}
