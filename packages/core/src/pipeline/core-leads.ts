import {
  accounts,
  brokerEvents,
  jobs,
  type LeadStatus,
  leads,
  people,
  profileSnapshots,
  profiles,
  projects,
} from "@scrapers/db";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  type AccountRef,
  assignPersona,
  detectLanguage,
  linkedAccounts,
  parseAccountUrl,
  profileChanges,
  risingSignal,
  searchTextOf,
} from "../extract/index.js";
import type { LeadFeatures } from "../learn/model.js";
import { redactSecrets } from "../notify.js";
import type { LeadScore, ScoringInput } from "../scoring.js";
import { AccountNotFoundError, type RawProfile } from "../types.js";
import type { Store } from "./core-store.js";
import {
  type LeadFilters,
  type LeadRow,
  ScoringUnavailableError,
  type ScrapersDeps,
} from "./shared.js";

/** Leads and people: saving profiles, linked accounts, the own model, personas, scoring, job completion and lead pages. */
export function createLeadStore(deps: ScrapersDeps, prev: Store) {
  const { db, scorer } = deps;
  const { connectors, notify, jobLabel, bump } = prev;
  /** Marks a running job done once every discovered account is accounted for. */
  async function finishIfComplete(jobId: string) {
    const finished = await db
      .update(jobs)
      .set({ status: "done", finishedAt: new Date() })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, "running"),
          sql`coalesce((${jobs.counts}->>'enriched')::int, 0) + coalesce((${jobs.counts}->>'skipped')::int, 0)
            + coalesce((${jobs.counts}->>'failed')::int, 0) >= coalesce((${jobs.counts}->>'discovered')::int, 0)`,
        ),
      )
      .returning({ id: jobs.id });
    if (finished.length === 0) return;
    const j = await jobLabel(jobId);
    if (!j) return;
    const c = j.counts;
    await notify({
      type: "job",
      level: (c.failed ?? 0) > (c.enriched ?? 0) ? "warn" : "ok",
      title: `انتهت مهمة ${j.project}`,
      body: `${j.sourceUrl}\nمكتشفة ${c.discovered ?? 0} · جُلبت ${c.enriched ?? 0} · بوسيلة تواصل ${c.leads ?? 0} · فشلت ${c.failed ?? 0}`,
      url: `/jobs/${jobId}`,
      key: `job-done:${jobId}`,
    });
    await afterJobDone(jobId);
  }

  /** Scores the job when its project has AI criteria, then hands it over for export. */
  async function afterJobDone(jobId: string) {
    const [row] = await db
      .select({ criteria: projects.aiCriteria })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .where(eq(jobs.id, jobId));
    if (scorer && row?.criteria) {
      try {
        const r = await scoreJob(jobId, row.criteria, {});
        if (r.mode === "batch") return; // exported when the batch is collected
      } catch (err) {
        console.error("[auto-score]", redactSecrets((err as Error).message));
      }
    }
    await readyToExport(jobId);
  }

  async function readyToExport(jobId: string) {
    if (!deps.onReadyToExport) return;
    try {
      await deps.onReadyToExport(jobId);
    } catch (err) {
      await notify({
        type: "job",
        level: "warn",
        title: "تعذّر التصدير التلقائي",
        body: redactSecrets((err as Error).message),
        url: `/jobs/${jobId}`,
        key: `auto-export-failed:${jobId}`,
      });
    }
  }

  async function saveProfile(
    p: RawProfile,
    fetchedBy: "graph" | "apify" | "worker",
    quality: { engagementRate: number | null; flags: string[] },
  ): Promise<string[]> {
    const [before] = await db.select().from(profiles).where(eq(profiles.igUserId, p.igUserId));
    // A username can move to a new account; drop the stale row first.
    await db
      .delete(profiles)
      .where(
        and(eq(profiles.username, p.username.toLowerCase()), ne(profiles.igUserId, p.igUserId)),
      );
    const values = {
      igUserId: p.igUserId,
      username: p.username.toLowerCase(),
      fullName: p.fullName ?? null,
      bio: p.bio ?? null,
      followers: p.followers ?? null,
      following: p.following ?? null,
      posts: p.posts ?? null,
      isBusiness: p.isBusiness,
      isVerified: p.isVerified,
      category: p.category ?? null,
      externalUrl: p.externalUrl ?? null,
      businessEmail: p.businessEmail ?? null,
      businessPhone: p.businessPhone ?? null,
      businessPhoneCountryCode: p.businessPhoneCountryCode ?? null,
      businessWhatsapp: p.businessWhatsapp ?? null,
      city: p.city ?? null,
      engagementRate: quality.engagementRate === null ? null : String(quality.engagementRate),
      qualityFlags: quality.flags.length ? quality.flags : null,
      language: detectLanguage(`${p.fullName ?? ""} ${p.bio ?? ""}`),
      searchText: searchTextOf(p),
      fetchedAt: new Date(),
      fetchedBy,
    };
    // Every fetch is kept as a snapshot, so growth over time can be read.
    await db.insert(profileSnapshots).values({
      profileId: p.igUserId,
      followers: values.followers,
      following: values.following,
      posts: values.posts,
      isBusiness: values.isBusiness,
    });
    const history = await db
      .select({ at: profileSnapshots.at, followers: profileSnapshots.followers })
      .from(profileSnapshots)
      .where(
        and(
          eq(profileSnapshots.profileId, p.igUserId),
          gte(profileSnapshots.at, new Date(Date.now() - 120 * 86_400_000)),
        ),
      )
      .orderBy(profileSnapshots.at);
    const rise = risingSignal(history);
    const signals = [
      ...(rise.rising ? ["rising"] : []),
      ...(before && !before.isBusiness && p.isBusiness ? ["became_business"] : []),
    ];
    // Every Instagram account belongs to a person; their other platforms hang off the person.
    let personId = before?.personId ?? null;
    if (!personId) {
      const [person] = await db.insert(people).values({}).returning({ id: people.id });
      personId = person?.id ?? null;
    }
    const row = { ...values, personId, signals: signals.length ? signals : null };
    await db
      .insert(profiles)
      .values(row)
      .onConflictDoUpdate({ target: profiles.igUserId, set: row });
    if (personId) await linkAccounts(personId, linkedAccounts(p.bio, p.externalUrl), "bio_link");
    const changes = before ? profileChanges(before, values) : [];
    if (rise.rising && !before?.signals?.includes("rising"))
      changes.push(`ينمو بسرعة (+${rise.percent}% خلال ${rise.days} يوماً)`);
    return changes;
  }

  async function saveScores(scores: Map<string, LeadScore>) {
    for (const [leadId, sc] of scores) {
      const tags = [sc.segment, sc.language, sc.country].filter((t): t is string => !!t);
      await db
        .update(leads)
        .set({
          aiScore: Math.round(Math.min(100, Math.max(0, sc.score))),
          aiTags: tags,
          aiReason: sc.reason.slice(0, 300),
          ...(sc.country && /^[A-Za-z]{2}$/.test(sc.country)
            ? { country: sql`coalesce(${leads.country}, ${sc.country.toUpperCase()})` }
            : {}),
        })
        .where(eq(leads.id, leadId));
    }
  }

  /**
   * Attaches accounts to a person. An account already attached to someone
   * else stays where it is (two people never share an account).
   */
  async function linkAccounts(
    personId: string,
    refs: AccountRef[],
    source: "bio_link" | "manual" | "website",
  ) {
    const own = refs.filter((r) => !(r.platform === "instagram"));
    if (own.length === 0) return [];
    return db
      .insert(accounts)
      .values(
        own.map((r) => ({ personId, platform: r.platform, handle: r.handle, url: r.url, source })),
      )
      .onConflictDoNothing({ target: [accounts.platform, accounts.handle] })
      .returning({ id: accounts.id, platform: accounts.platform });
  }

  /** Reads an account through its platform's connector and stores what it found. */
  async function refreshAccount(id: string) {
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, id));
    if (!acc) return null;
    const connector = connectors.get(acc.platform);
    if (!connector) return acc;
    try {
      const r = await connector.getAccount(acc.handle);
      // Accounts the person links from there (e.g. their website's social icons) are theirs too.
      if (r.links?.length)
        await linkAccounts(
          acc.personId,
          r.links.map((l) => parseAccountUrl(l)).filter((x): x is AccountRef => !!x),
          "website",
        );
      const [updated] = await db
        .update(accounts)
        .set({
          displayName: r.displayName,
          bio: r.bio?.slice(0, 2000) ?? null,
          followers: r.followers,
          stats: r.stats ?? null,
          fetchedAt: new Date(),
          error: null,
        })
        .where(eq(accounts.id, id))
        .returning();
      return updated ?? acc;
    } catch (err) {
      const message =
        err instanceof AccountNotFoundError
          ? "غير موجود أو خاص"
          : (err as Error).message.slice(0, 300);
      const [updated] = await db
        .update(accounts)
        .set({ error: message, fetchedAt: new Date() })
        .where(eq(accounts.id, id))
        .returning();
      return updated ?? acc;
    }
  }

  /** What the model reads for every lead of a project, with its outcome when known. */
  async function projectFeatures(projectId: string) {
    const rows = await db
      .select({
        id: leads.id,
        status: leads.status,
        aiScore: leads.aiScore,
        sourceCount: leads.sourceCount,
        email: leads.email,
        phone: sql<string | null>`coalesce(${leads.phoneE164}, ${leads.phoneRaw})`,
        followers: profiles.followers,
        engagementRate: profiles.engagementRate,
        isBusiness: profiles.isBusiness,
        language: profiles.language,
        signals: profiles.signals,
        qualityFlags: profiles.qualityFlags,
      })
      .from(leads)
      .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
      .where(eq(leads.projectId, projectId))
      .limit(50_000);
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      aiScore: r.aiScore,
      features: {
        followers: r.followers,
        engagementRate: r.engagementRate === null ? null : Number(r.engagementRate),
        sourceCount: r.sourceCount,
        isBusiness: r.isBusiness,
        hasEmail: !!r.email,
        hasPhone: !!r.phone,
        aiScore: r.aiScore,
        arabic: r.language === "ar",
        rising: !!r.signals?.includes("rising"),
        qualityFlags: r.qualityFlags?.length ?? 0,
      } satisfies LeadFeatures,
    }));
  }

  /** Customers and interested leads are wins; rejected ones are losses; the rest are unknown. */
  const outcomeOf = (status: string): 0 | 1 | null =>
    status === "customer" || status === "interested" ? 1 : status === "rejected" ? 0 : null;

  /**
   * A lead's deal value from the broker's events: commissions when the broker
   * reports them, otherwise deposits. Status becomes customer on a deposit.
   */
  async function refreshDealFromBroker(leadId: string) {
    const [agg] = await db
      .select({
        commission: sql<string>`coalesce(sum(${brokerEvents.amount}) filter (where ${brokerEvents.event} = 'commission'), 0)`,
        deposits: sql<string>`coalesce(sum(${brokerEvents.amount}) filter (where ${brokerEvents.event} in ('ftd', 'deposit')), 0)`,
        funded: sql<number>`count(*) filter (where ${brokerEvents.event} in ('ftd', 'deposit', 'commission'))::int`,
        first: sql<Date | null>`min(${brokerEvents.at}) filter (where ${brokerEvents.event} in ('ftd', 'deposit', 'commission'))`,
      })
      .from(brokerEvents)
      .where(eq(brokerEvents.leadId, leadId));
    if (!agg || Number(agg.funded) === 0) return;
    const commission = Number(agg.commission);
    const value = commission > 0 ? commission : Number(agg.deposits);
    await db
      .update(leads)
      .set({
        status: "customer",
        statusAt: sql`coalesce(${leads.statusAt}, now())`,
        dealValue: value.toFixed(2),
        dealAt: sql`coalesce(${leads.dealAt}, ${agg.first ? new Date(agg.first).toISOString() : new Date().toISOString()}::timestamptz)`,
        followUpAt: null,
      })
      .where(eq(leads.id, leadId));
  }

  /** Puts every lead of the project in the persona whose words it uses most. */
  async function assignPersonas(
    projectId: string,
    personas: { name: string; keywords: string[] }[],
  ): Promise<number> {
    const rows = await db
      .select({
        id: leads.id,
        text: profiles.searchText,
        username: profiles.username,
        bio: profiles.bio,
      })
      .from(leads)
      .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
      .where(eq(leads.projectId, projectId))
      .limit(50_000);
    const groups = new Map<string | null, string[]>();
    for (const r of rows) {
      const name = assignPersona(
        r.text ?? searchTextOf({ username: r.username, bio: r.bio }),
        personas,
      );
      const ids = groups.get(name) ?? [];
      ids.push(r.id);
      groups.set(name, ids);
    }
    let assigned = 0;
    for (const [name, ids] of groups) {
      for (let i = 0; i < ids.length; i += 1000) {
        await db
          .update(leads)
          .set({ persona: name })
          .where(inArray(leads.id, ids.slice(i, i + 1000)));
      }
      if (name) assigned += ids.length;
    }
    return assigned;
  }

  /**
   * Adds the owner's own decisions to the criteria (accounts they marked as
   * customers or interested, and ones they rejected), so scoring follows them.
   */
  async function withExamples(projectId: string, criteria: string): Promise<string> {
    const pick = (statuses: LeadStatus[]) =>
      db
        .select({ username: profiles.username, bio: profiles.bio, category: profiles.category })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(and(eq(leads.projectId, projectId), inArray(leads.status, statuses)))
        .orderBy(desc(leads.statusAt))
        .limit(6);
    const [good, bad] = await Promise.all([pick(["customer", "interested"]), pick(["rejected"])]);
    if (good.length + bad.length < 3) return criteria;
    const line = (r: { username: string; bio: string | null; category: string | null }) =>
      `- @${r.username}${r.category ? ` (${r.category})` : ""}: ${(r.bio ?? "").replace(/\s+/g, " ").slice(0, 140)}`;
    return [
      criteria,
      good.length
        ? `\nAccounts the operator accepted (score similar ones higher):\n${good.map(line).join("\n")}`
        : "",
      bad.length
        ? `\nAccounts the operator rejected (score similar ones lower):\n${bad.map(line).join("\n")}`
        : "",
    ].join("\n");
  }

  async function scoreJob(jobId: string, criteria: string, opts: { rescore?: boolean }) {
    if (!scorer)
      throw new ScoringUnavailableError(
        "AI scoring needs ANTHROPIC_API_KEY (or let Claude score over MCP)",
      );
    const rows = await db
      .select({ lead: leads, profile: profiles })
      .from(leads)
      .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
      .where(and(eq(leads.jobId, jobId), opts.rescore ? undefined : isNull(leads.aiScore)));
    const items: ScoringInput[] = rows.map(({ lead, profile }) => ({
      id: lead.id,
      username: profile.username,
      fullName: profile.fullName,
      bio: profile.bio,
      followers: profile.followers,
      isBusiness: profile.isBusiness,
      isVerified: profile.isVerified,
      category: profile.category,
      externalUrl: profile.externalUrl,
      sources: lead.sourceCount,
    }));
    if (items.length === 0) return { mode: "none" as const, count: 0 };
    const [first] = rows;
    if (first) criteria = await withExamples(first.lead.projectId, criteria);
    if (items.length > scorer.batchThreshold) {
      const batchId = await scorer.submitBatch(items, criteria);
      await db
        .update(jobs)
        .set({
          counts: sql`${jobs.counts} || ${JSON.stringify({ aiBatchId: batchId, aiCriteria: criteria })}::jsonb`,
        })
        .where(eq(jobs.id, jobId));
      return { mode: "batch" as const, count: items.length, batchId };
    }
    const scores = await scorer.scoreNow(items, criteria);
    await saveScores(scores);
    await bump(jobId, { scored: scores.size });
    return { mode: "now" as const, count: scores.size };
  }

  const scoreKey = sql`coalesce(${leads.aiScore}, -1)`;

  const followersKey = sql`coalesce(${profiles.followers}, -1)`;

  const encodeCursor = (c: { s: number; f: number; id: string }) =>
    Buffer.from(JSON.stringify(c)).toString("base64url");

  const decodeCursor = (c: string): { s: number; f: number; id: string } | null => {
    try {
      const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
      return typeof v.s === "number" && typeof v.f === "number" && typeof v.id === "string"
        ? v
        : null;
    } catch {
      return null;
    }
  };

  async function leadsPage(
    f: LeadFilters,
  ): Promise<{ leads: LeadRow[]; nextCursor: string | null }> {
    const conds: (SQL | undefined)[] = [eq(leads.projectId, f.projectId)];
    if (f.jobId) conds.push(eq(leads.jobId, f.jobId));
    if (f.business) conds.push(eq(profiles.isBusiness, true));
    if (f.hasEmail) conds.push(isNotNull(leads.email));
    if (f.hasPhone) conds.push(or(isNotNull(leads.phoneE164), isNotNull(leads.phoneRaw)));
    if (f.minScore !== undefined) conds.push(gte(leads.aiScore, f.minScore));
    if (f.status) conds.push(eq(leads.status, f.status));
    if (f.country) conds.push(eq(leads.country, f.country.toUpperCase()));
    if (f.language) conds.push(eq(profiles.language, f.language.toLowerCase()));
    if (f.minSources) conds.push(gte(leads.sourceCount, f.minSources));
    if (f.minFollowers !== undefined) conds.push(gte(profiles.followers, f.minFollowers));
    if (f.maxFollowers !== undefined) conds.push(lte(profiles.followers, f.maxFollowers));
    if (f.persona) conds.push(eq(leads.persona, f.persona));
    if (f.minWinProb !== undefined) conds.push(gte(leads.winProb, f.minWinProb));
    if (f.platform)
      conds.push(
        sql`exists (select 1 from ${accounts} a where a.person_id = ${profiles.personId} and a.platform = ${f.platform})`,
      );
    if (f.signal) conds.push(sql`${profiles.signals} @> array[${f.signal}]::text[]`);
    const terms = (f.terms ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1);
    if (terms.length)
      conds.push(
        or(
          ...terms
            .slice(0, 20)
            .map(
              (t) =>
                sql`(${profiles.searchText} ilike ${`%${t.replace(/[%_\\]/g, (m) => `\\${m}`)}%`} or word_similarity(${t}, ${profiles.searchText}) > 0.6)`,
            ),
        ),
      );
    if (f.q?.trim()) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      conds.push(
        sql`(${profiles.username} ilike ${like} or ${profiles.fullName} ilike ${like} or ${profiles.bio} ilike ${like})`,
      );
    }
    const cursor = f.cursor ? decodeCursor(f.cursor) : null;
    if (cursor)
      conds.push(
        sql`(${scoreKey}, ${followersKey}, ${leads.id}) < (${cursor.s}, ${cursor.f}, ${cursor.id}::uuid)`,
      );
    const limit = Math.min(f.limit ?? 50, 5000);
    const rows = await db
      .select({
        lead: leads,
        profile: profiles,
        sourceUrl: jobs.sourceUrl,
        others: sql<number>`(select count(*)::int from ${leads} as l2 where l2.profile_id = ${leads.profileId} and l2.project_id <> ${leads.projectId})`,
      })
      .from(leads)
      .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
      .innerJoin(jobs, eq(jobs.id, leads.jobId))
      .where(and(...conds))
      .orderBy(desc(scoreKey), desc(followersKey), desc(leads.id))
      .limit(limit)
      .offset(cursor ? 0 : (f.offset ?? 0));
    const out: LeadRow[] = rows.map(({ lead, profile, sourceUrl, others }) => ({
      username: profile.username,
      fullName: profile.fullName,
      category: profile.category,
      followers: profile.followers,
      isBusiness: profile.isBusiness,
      email: lead.email,
      phone: lead.phoneE164 ?? lead.phoneRaw,
      phoneCountry: lead.phoneCountry,
      phoneConfirmed: !!lead.phoneE164,
      contactSource: lead.contactSource,
      followUpAt: lead.followUpAt,
      sources: lead.sources,
      sourceCount: lead.sourceCount,
      dealValue: lead.dealValue === null ? null : Number(lead.dealValue),
      winProb: lead.winProb,
      persona: lead.persona,
      signals: profile.signals,
      country: lead.country,
      language: profile.language,
      aiScore: lead.aiScore,
      aiTags: lead.aiTags,
      aiReason: lead.aiReason,
      status: lead.status,
      statusNote: lead.statusNote,
      city: profile.city,
      engagementRate: profile.engagementRate === null ? null : Number(profile.engagementRate),
      qualityFlags: profile.qualityFlags,
      otherProjects: Number(others ?? 0),
      sourceUrl,
      fetchedAt: profile.fetchedAt,
    }));
    const last = rows.at(-1);
    const nextCursor =
      rows.length === limit && last
        ? encodeCursor({
            s: last.lead.aiScore ?? -1,
            f: last.profile.followers ?? -1,
            id: last.lead.id,
          })
        : null;
    return { leads: out, nextCursor };
  }

  return {
    finishIfComplete,
    afterJobDone,
    readyToExport,
    saveProfile,
    saveScores,
    linkAccounts,
    refreshAccount,
    projectFeatures,
    outcomeOf,
    refreshDealFromBroker,
    assignPersonas,
    withExamples,
    scoreJob,
    scoreKey,
    followersKey,
    encodeCursor,
    decodeCursor,
    leadsPage,
  };
}

export type LeadStore = ReturnType<typeof createLeadStore>;
