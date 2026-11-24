import { randomBytes } from "node:crypto";
import { jobs, leads, monitors, profiles, projects } from "@scrapers/db";
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { searchTextOf } from "../../extract/index.js";
import { type BudgetLine, planBudget } from "../../learn/budget.js";
import {
  auc,
  explainModel,
  MIN_LABELLED,
  MIN_POSITIVES,
  predictWin,
  type TrainedModel,
  trainModel,
} from "../../learn/model.js";
import type { Core } from "../core.js";
import { ScoringUnavailableError } from "../core.js";

import type { CoreSelf } from "./context.js";

/** What brings money and what to do next: sources, segments, the own model, budget, suggestions, weekly plan. */
export function insightsMethods(core: Core, api: () => CoreSelf) {
  const {
    deps,
    db,
    router,
    scorer,
    getValue,
    setValue,
    maxLimit,
    projectFeatures,
    outcomeOf,
    assignPersonas,
    leadsPage,
  } = core;

  /**
   * What each source (competitor followers, post, hashtag, upload) brought:
   * accounts, contacts, how far they got, deals and their value, cost, and
   * return. A lead found in several sources counts in each; its deal value
   * is split evenly between them so totals add up.
   */
  async function sourcePerformance(projectId: string, opts: { since?: Date } = {}) {
    const since = opts.since
      ? sql`and l.created_at >= ${opts.since.toISOString()}::timestamptz`
      : sql``;
    const res = await db.execute<{
      source: string;
      leads: number;
      contact: number;
      reached: number;
      interested: number;
      customers: number;
      revenue: string | null;
      days_to_close: string | null;
    }>(sql`
      select src as source,
             count(*)::int as leads,
             count(*) filter (where l.email is not null or l.phone_e164 is not null or l.phone_raw is not null)::int as contact,
             count(*) filter (where l.status <> 'new')::int as reached,
             count(*) filter (where l.status in ('interested', 'customer'))::int as interested,
             count(*) filter (where l.status = 'customer')::int as customers,
             sum(l.deal_value / greatest(l.source_count, 1)) as revenue,
             avg(extract(epoch from (l.deal_at - l.created_at)) / 86400) filter (where l.deal_at is not null) as days_to_close
      from ${leads} l
      cross join lateral unnest(coalesce(l.sources, '{}'::text[])) as src
      where l.project_id = ${projectId}::uuid ${since}
      group by src`);
    const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as {
      source: string;
      leads: number;
      contact: number;
      reached: number;
      interested: number;
      customers: number;
      revenue: string | null;
      days_to_close: string | null;
    }[];
    const costs = await db
      .select({
        source: jobs.sourceUrl,
        cost: sql<string>`sum(${jobs.costUsd})`,
        runs: sql<number>`count(*)::int`,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.projectId, projectId),
          opts.since ? gte(jobs.createdAt, opts.since) : undefined,
        ),
      )
      .groupBy(jobs.sourceUrl);
    const costBy = new Map(
      costs.map((c) => [c.source, { cost: Number(c.cost ?? 0), runs: c.runs }]),
    );
    const out = rows.map((r) => {
      const revenue = Math.round(Number(r.revenue ?? 0) * 100) / 100;
      const cost = Math.round((costBy.get(r.source)?.cost ?? 0) * 10000) / 10000;
      return {
        source: r.source,
        runs: costBy.get(r.source)?.runs ?? 0,
        leads: Number(r.leads),
        contact: Number(r.contact),
        reached: Number(r.reached),
        interested: Number(r.interested),
        customers: Number(r.customers),
        revenue,
        costUsd: cost,
        /** Revenue per dollar spent; null when nothing was spent. */
        roi: cost > 0 ? Math.round((revenue / cost) * 10) / 10 : null,
        /** Share of reached accounts that became customers, in percent. */
        closeRate:
          Number(r.reached) > 0
            ? Math.round((Number(r.customers) / Number(r.reached)) * 1000) / 10
            : null,
        costPerCustomer:
          Number(r.customers) > 0 ? Math.round((cost / Number(r.customers)) * 100) / 100 : null,
        daysToClose:
          r.days_to_close === null ? null : Math.round(Number(r.days_to_close) * 10) / 10,
      };
    });
    out.sort((a, b) => b.revenue - a.revenue || b.customers - a.customers || b.leads - a.leads);
    const total = out.reduce(
      (t, r) => ({ revenue: t.revenue + r.revenue, costUsd: t.costUsd + r.costUsd }),
      { revenue: 0, costUsd: 0 },
    );
    const [deals] = await db
      .select({
        customers: sql<number>`count(*) filter (where ${leads.status} = 'customer')::int`,
        withValue: sql<number>`count(*) filter (where ${leads.dealValue} is not null)::int`,
      })
      .from(leads)
      .where(eq(leads.projectId, projectId));
    return {
      sources: out,
      totals: {
        revenue: Math.round(total.revenue * 100) / 100,
        costUsd: Math.round(total.costUsd * 10000) / 10000,
        customers: deals?.customers ?? 0,
        /** Customers whose deal value is recorded; the report is only as good as this. */
        customersWithValue: deals?.withValue ?? 0,
      },
    };
  }

  /**
   * Next period's collection budget split across the project's sources by
   * what they earned (see learn/budget), with each line matched to the
   * monitor that collects it, when there is one.
   */
  async function budgetPlan(projectId: string, budgetUsd: number) {
    const perf = await sourcePerformance(projectId);
    const unit = router.unitCost("apify") || 0.0025;
    const plan = planBudget(perf.sources, { budgetUsd, costPerAccount: unit * 2 });
    const mons = await api().listMonitors(projectId);
    return {
      ...plan,
      budgetUsd,
      costPerAccount: unit * 2,
      lines: plan.lines.map((l) => {
        const m = mons.find((x) => x.sourceUrl === l.source);
        return { ...l, monitorId: m?.id ?? null, monitorEnabled: m?.enabled ?? null };
      }),
    };
  }

  /**
   * How good the scoring is, judged by the owner's real decisions: the AUC of
   * the AI score and of the project's own model (0.5 = guessing, 1 = perfect).
   */
  async function evaluateScoring(projectId: string) {
    const rows = await projectFeatures(projectId);
    const labelled = rows
      .map((r) => ({ ...r, label: outcomeOf(r.status) }))
      .filter((r) => r.label !== null);
    const withAi = labelled.filter((r) => r.aiScore !== null);
    const project = await api().getProject(projectId);
    const model = (project?.model as TrainedModel | null | undefined) ?? null;
    return {
      labelled: labelled.length,
      positives: labelled.filter((r) => r.label === 1).length,
      aiScoreAuc: auc(
        withAi.map((r) => r.aiScore as number),
        withAi.map((r) => r.label as number),
      ),
      aiScored: withAi.length,
      model: model
        ? {
            auc: model.auc,
            trainedAt: model.trainedAt,
            trainedOn: model.trainedOn,
            explain: explainModel(model, 5),
          }
        : null,
    };
  }

  async function getPlan(id: string) {
    return getValue<{
      id: string;
      projectId: string;
      createdAt: string;
      text: string;
      lines: (BudgetLine & { monitorId: string | null })[];
      applied: boolean;
    }>(`plan:${id}`);
  }

  /**
   * Applies a budget plan to the monitors (the owner approved it): stopped
   * sources are paused; the others collect what their share buys per run.
   */
  async function applyBudgetPlan(
    projectId: string,
    lines: (BudgetLine & { monitorId: string | null })[],
  ) {
    const mons = await api().listMonitors(projectId);
    let changed = 0;
    for (const l of lines) {
      const m = mons.find((x) => x.id === l.monitorId);
      if (!m) continue;
      if (l.decision === "stop") {
        await db.update(monitors).set({ enabled: false }).where(eq(monitors.id, m.id));
      } else {
        const runs = Math.max(1, Math.round(30 / m.everyDays));
        const limit = Math.min(maxLimit, Math.max(10, Math.floor(l.accounts / runs)));
        await db.update(monitors).set({ enabled: true, limit }).where(eq(monitors.id, m.id));
      }
      changed++;
    }
    return { changed };
  }

  /**
   * Trains the project's own model on the owner's decisions and scores every
   * lead with it. Too few decisions: nothing changes and the report says how
   * many more are needed.
   */
  async function trainProjectModel(projectId: string) {
    const rows = await projectFeatures(projectId);
    const labelled = rows
      .map((r) => ({ ...r, label: outcomeOf(r.status) }))
      .filter((r): r is typeof r & { label: 0 | 1 } => r.label !== null);
    const model = trainModel(labelled.map((r) => ({ features: r.features, label: r.label })));
    const positives = labelled.filter((r) => r.label === 1).length;
    const negatives = labelled.length - positives;
    if (!model)
      return {
        trained: false as const,
        positives,
        negatives,
        needed: {
          positives: Math.max(0, MIN_POSITIVES - positives),
          negatives: Math.max(0, MIN_POSITIVES - negatives),
          total: Math.max(0, MIN_LABELLED - labelled.length),
        },
      };
    await db
      .update(projects)
      .set({ model: model as unknown as Record<string, unknown> })
      .where(eq(projects.id, projectId));
    // One update per probability value keeps this to at most 101 statements.
    const byProb = new Map<number, string[]>();
    for (const r of rows) {
      const p = predictWin(model, r.features);
      byProb.set(p, [...(byProb.get(p) ?? []), r.id]);
    }
    for (const [p, ids] of byProb)
      for (let i = 0; i < ids.length; i += 1000)
        await db
          .update(leads)
          .set({ winProb: p })
          .where(inArray(leads.id, ids.slice(i, i + 1000)));
    return { trained: true as const, positives, negatives, auc: model.auc, scored: rows.length };
  }

  return {
    sourcePerformance,

    /**
     * Accounts in the project that read most like this one (name, category and
     * bio, by trigram similarity): "find more like my best customer".
     */
    async similarLeads(projectId: string, username: string, limit = 10) {
      const u = username.replace(/^@/, "").toLowerCase();
      const [seed] = await db
        .select({ id: profiles.igUserId, text: profiles.searchText, bio: profiles.bio })
        .from(profiles)
        .where(eq(profiles.username, u));
      if (!seed) return [];
      const text = seed.text ?? searchTextOf({ username: u, bio: seed.bio });
      const score = sql<number>`similarity(${profiles.searchText}, ${text})`;
      const rows = await db
        .select({
          username: profiles.username,
          fullName: profiles.fullName,
          followers: profiles.followers,
          status: leads.status,
          aiScore: leads.aiScore,
          persona: leads.persona,
          similarity: score,
        })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(
          and(
            eq(leads.projectId, projectId),
            ne(leads.profileId, seed.id),
            // Measured: same-topic bios score 0.2-0.3, unrelated ones about 0.1.
            sql`${score} > 0.15`,
          ),
        )
        .orderBy(desc(score))
        .limit(Math.min(limit, 50));
      return rows.map((r) => ({ ...r, similarity: Math.round(Number(r.similarity) * 100) / 100 }));
    },

    /**
     * Finds the project's audience segments with AI (from a sample of bios),
     * saves them, and assigns every lead to the segment whose words it uses.
     */
    async buildPersonas(projectId: string) {
      if (!scorer?.personas)
        throw new ScoringUnavailableError("Audience segments need ANTHROPIC_API_KEY");
      const project = await api().getProject(projectId);
      if (!project) throw new Error("Project not found");
      const sample = await db
        .select({ username: profiles.username, bio: profiles.bio, category: profiles.category })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(and(eq(leads.projectId, projectId), isNotNull(profiles.bio)))
        .orderBy(sql`random()`)
        .limit(150);
      if (sample.length < 5) throw new Error("نحتاج 5 حسابات على الأقل لها بايو");
      const personas = (await scorer.personas(sample, project.aiCriteria ?? "")).slice(0, 8);
      await db.update(projects).set({ personas }).where(eq(projects.id, projectId));
      const assigned = await assignPersonas(projectId, personas);
      return { personas, assigned };
    },

    /** Leads, customers and revenue per audience segment. */
    async personaPerformance(projectId: string) {
      const rows = await db
        .select({
          persona: leads.persona,
          leads: sql<number>`count(*)::int`,
          reached: sql<number>`count(*) filter (where ${leads.status} <> 'new')::int`,
          customers: sql<number>`count(*) filter (where ${leads.status} = 'customer')::int`,
          revenue: sql<string>`coalesce(sum(${leads.dealValue}), 0)`,
        })
        .from(leads)
        .where(and(eq(leads.projectId, projectId), isNotNull(leads.persona)))
        .groupBy(leads.persona);
      return rows
        .map((r) => ({
          persona: r.persona as string,
          leads: Number(r.leads),
          reached: Number(r.reached),
          customers: Number(r.customers),
          revenue: Number(r.revenue),
          closeRate:
            Number(r.reached) > 0
              ? Math.round((Number(r.customers) / Number(r.reached)) * 1000) / 10
              : null,
        }))
        .sort((a, b) => b.revenue - a.revenue || b.customers - a.customers || b.leads - a.leads);
    },

    trainProjectModel,

    evaluateScoring,

    budgetPlan,

    applyBudgetPlan,

    /** Whether new sources can be found from customers' follows (needs Apify). */
    get suggestionsAvailable() {
      return !!deps.following;
    },

    /** What suggestSources would cost, before running it. */
    suggestCost(seeds = 8, perSeed = 150) {
      return deps.following
        ? Math.round(((deps.following.followingCostPer1k * seeds * perSeed) / 1000) * 100) / 100
        : null;
    },

    /**
     * New sources from the network: the accounts several of the owner's best
     * leads (customers first, then interested) follow, that are not watched
     * yet. Saved so the page can show them without paying again.
     */
    async suggestSources(projectId: string, opts: { seeds?: number; perSeed?: number } = {}) {
      if (!deps.following) throw new Error("اكتشاف المصادر يحتاج APIFY_TOKEN");
      const seeds = await db
        .select({ username: profiles.username })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(
          and(eq(leads.projectId, projectId), inArray(leads.status, ["customer", "interested"])),
        )
        .orderBy(sql`${leads.dealValue} desc nulls last`, desc(leads.statusAt))
        .limit(Math.min(opts.seeds ?? 8, 20));
      if (seeds.length < 3) throw new Error("نحتاج 3 عملاء أو مهتمين على الأقل لنعرف من يتابعون");
      const counts = new Map<string, number>();
      let read = 0;
      for (const s of seeds) {
        try {
          const follows = await deps.following.listFollowing(s.username, opts.perSeed ?? 150);
          read += follows.length;
          for (const f of new Set(follows)) counts.set(f, (counts.get(f) ?? 0) + 1);
        } catch {
          // A private or missing account is skipped.
        }
      }
      const watched = new Set(
        (await api().listMonitors(projectId))
          .map((m) => /instagram\.com\/([A-Za-z0-9._]{1,30})/.exec(m.sourceUrl)?.[1]?.toLowerCase())
          .filter(Boolean),
      );
      const seedNames = new Set(seeds.map((s) => s.username));
      const suggestions = [...counts.entries()]
        .filter(([u, n]) => n >= 2 && !watched.has(u) && !seedNames.has(u))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([username, followedBy]) => ({ username, followedBy }));
      const result = {
        at: new Date().toISOString(),
        seeds: seeds.length,
        read,
        costUsd: Math.round(((deps.following.followingCostPer1k * read) / 1000) * 100) / 100,
        suggestions,
      };
      await setValue(`suggest:${projectId}`, result, 60 * 86_400_000);
      return result;
    },

    async lastSuggestions(projectId: string) {
      return getValue<{
        at: string;
        seeds: number;
        read: number;
        costUsd: number;
        suggestions: { username: string; followedBy: number }[];
      }>(`suggest:${projectId}`);
    },

    /**
     * The weekly analyst: retrains the project's model, reads its revenue by
     * source, the budget plan, competitors' growth and site changes, and the
     * best new leads, then writes the plan (with AI when available). Budget
     * changes are saved as a pending plan and applied only when approved.
     */
    async weeklyPlan(projectId: string, budgetUsd: number, now = new Date()) {
      const project = await api().getProject(projectId);
      if (!project) throw new Error("Project not found");
      const model = await trainProjectModel(projectId);
      const [perf, budget, ev] = await Promise.all([
        sourcePerformance(projectId, { since: new Date(now.getTime() - 90 * 86_400_000) }),
        budgetPlan(projectId, budgetUsd),
        evaluateScoring(projectId),
      ]);
      const since = new Date(now.getTime() - 7 * 86_400_000);
      const changedSites = (await api().listSiteWatches()).filter(
        (w) => w.lastChangedAt && w.lastChangedAt >= since,
      );
      const best = await leadsPage({ projectId, status: "new", minWinProb: 60, limit: 5 });
      const rising = await leadsPage({ projectId, signal: "rising", limit: 5 });
      const changes = budget.lines.filter((l) => l.monitorId && l.decision !== "keep");
      const data = {
        project: project.name,
        revenue90d: perf.totals,
        topSources: perf.sources.slice(0, 5).map((s) => ({
          source: s.source,
          customers: s.customers,
          revenue: s.revenue,
          cost: s.costUsd,
        })),
        model: model.trained ? { auc: model.auc } : { needed: model.needed },
        aiScoreAuc: ev.aiScoreAuc,
        budget: {
          usd: budgetUsd,
          changes: changes.map((l) => ({ source: l.source, decision: l.decision, usd: l.usd })),
        },
        competitorSiteChanges: changedSites.map((w) => ({
          page: w.label ?? w.url,
          added: w.lastDiff?.added.slice(0, 3) ?? [],
        })),
        contactFirst: best.leads.map((l) => ({ username: l.username, winProb: l.winProb })),
        rising: rising.leads.map((l) => l.username),
      };
      let text = "";
      if (scorer?.weeklyBrief) {
        try {
          text = await scorer.weeklyBrief(data);
        } catch {
          text = "";
        }
      }
      if (!text) {
        const money = (n: number) => `$${n.toLocaleString("en", { maximumFractionDigits: 2 })}`;
        text = [
          `خطة الأسبوع · ${project.name}`,
          `آخر 90 يوماً: ${money(perf.totals.revenue)} من ${perf.totals.customers} عميل، بتكلفة جمع ${money(perf.totals.costUsd)}.`,
          perf.sources[0]
            ? `الأفضل: ${perf.sources[0].source} (${perf.sources[0].customers} عميل).`
            : "",
          model.trained
            ? `نموذجك محدَّث (دقة الترتيب ${Math.round((model.auc ?? 0) * 100)}%).`
            : `النموذج ينتظر قرارات أكثر: سجّل ${model.needed.positives} عملاء و${model.needed.negatives} مرفوضين على الأقل.`,
          changes.length
            ? `تغييرات الميزانية المقترحة: ${changes.map((l) => `${l.decision === "stop" ? "أوقف" : l.decision === "increase" ? "زِد" : l.decision === "decrease" ? "خفّض" : "جرّب"} ${l.source}`).join("، ")}.`
            : "لا تغيير في الميزانية.",
          best.leads.length
            ? `ابدأ بـ: ${best.leads.map((l) => `@${l.username} (${l.winProb}%)`).join("، ")}.`
            : "",
          rising.leads.length
            ? `ينمون بسرعة: ${rising.leads.map((l) => `@${l.username}`).join("، ")}.`
            : "",
          changedSites.length ? `تغيّرت ${changedSites.length} من صفحات المنافسين هذا الأسبوع.` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      const id = randomBytes(6).toString("hex");
      await setValue(
        `plan:${id}`,
        { id, projectId, createdAt: now.toISOString(), text, lines: changes, applied: false },
        14 * 86_400_000,
      );
      await setValue(`plan:last:${projectId}`, id, 14 * 86_400_000);
      return { id, text, changes: changes.length };
    },

    getPlan,

    async lastPlan(projectId: string) {
      const id = await getValue<string>(`plan:last:${projectId}`);
      return id ? getPlan(id) : null;
    },

    /** Applies a weekly plan the owner approved (once). */
    async approvePlan(id: string) {
      const plan = await getPlan(id);
      if (!plan) return { ok: false as const, reason: "expired" };
      if (plan.applied) return { ok: false as const, reason: "applied" };
      const r = await applyBudgetPlan(plan.projectId, plan.lines);
      await setValue(`plan:${id}`, { ...plan, applied: true }, 14 * 86_400_000);
      await api().audit({
        actor: "owner",
        action: "plan.approve",
        detail: { id, changed: r.changed },
      });
      return { ok: true as const, changed: r.changed };
    },
  };
}
