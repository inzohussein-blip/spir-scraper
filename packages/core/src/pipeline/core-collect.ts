import {
  auditLog,
  competitorSnapshots,
  counters,
  engineEvents,
  engineRuns,
  ephemeral,
  jobs,
  leadEvents,
  leads,
  notifications,
  partnerClicks,
  profileSnapshots,
  profiles,
  projects,
  toolRuns,
  usageDaily,
  usageSlots,
} from "@scrapers/db";
import { and, eq, gte, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import {
  assignPersona,
  detectLanguage,
  profileQuality,
  resolveContact,
  searchTextOf,
} from "../extract/index.js";
import { predictWin, type TrainedModel } from "../learn/model.js";
import { suppressionHash } from "../suppression.js";
import { NotFoundError, type ProviderId, type RawProfile } from "../types.js";
import type { LeadStore } from "./core-leads.js";
import type { Store } from "./core-store.js";
import { NoProviderError, type ProviderRouter } from "./router.js";
import {
  type DiscoverPayload,
  ENRICH_BATCH,
  ENRICH_CONCURRENCY,
  type EnrichPayload,
  QUEUES,
  type ScrapersDeps,
  sourceFromJob,
} from "./shared.js";

/** Collection: discovery, enrichment, pending scores, retention, background runs and the serverless drain. */
export function createCollector(deps: ScrapersDeps, prev: Store & LeadStore) {
  const { db, boss, router, config, scorer } = deps;
  const {
    lateApi,
    resolveDeps,
    cacheDays,
    pepper,
    getValue,
    setValue,
    claimOnce,
    loadRouterState,
    saveRouterState,
    notify,
    jobLabel,
    addCost,
    bump,
    suppressedHashes,
    finishIfComplete,
    readyToExport,
    saveProfile,
    saveScores,
  } = prev;
  async function handleDiscover(payload: DiscoverPayload) {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, payload.jobId));
    if (job?.status !== "queued") return;
    await db
      .update(jobs)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(jobs.id, job.id));

    let usernames: string[];
    try {
      if (job.sourceType === "upload") {
        usernames = (payload.usernames ?? []).slice(0, job.limit);
      } else {
        const source = sourceFromJob(job);
        if (job.limit > (config.backgroundAbove ?? 300)) {
          // A large list: a background run that reports back when it is done.
          const started = await router.startEngagers(
            source,
            job.limit,
            config.discoveryNotifyUrl ?? null,
          );
          if (started) {
            await db.update(jobs).set({ provider: started.provider }).where(eq(jobs.id, job.id));
            await setValue(
              `discover-run:${job.id}`,
              { runId: started.runId, provider: started.provider, startedAt: Date.now() },
              3 * 86_400_000,
            );
            return;
          }
        }
        const found = await router.listEngagers(source, job.limit);
        usernames = found.usernames;
        await db.update(jobs).set({ provider: found.provider }).where(eq(jobs.id, job.id));
        await addCost(job.id, router.unitCost(found.provider) * usernames.length);
      }
    } catch (err) {
      await db
        .update(jobs)
        .set({ status: "failed", error: (err as Error).message, finishedAt: new Date() })
        .where(eq(jobs.id, job.id));
      const label = await jobLabel(job.id);
      await notify({
        type: "job",
        level: "bad",
        title: `فشلت مهمة ${label?.project ?? ""}`.trim(),
        body: `${job.sourceUrl}\n${(err as Error).message}`,
        url: `/jobs/${job.id}`,
        key: `job-failed:${job.id}`,
      });
      return;
    }
    await continueDiscovery(job, usernames);
  }

  /** Discovered usernames (from a request or a background run) go on to be read. */
  async function continueDiscovery(job: typeof jobs.$inferSelect, found: string[]) {
    let usernames = found;
    if (job.onlyNew && usernames.length > 0) {
      // Monitors collect only people the project does not have yet.
      const known = await db
        .select({ username: profiles.username })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(and(eq(leads.projectId, job.projectId), inArray(profiles.username, usernames)));
      const have = new Set(known.map((k) => k.username));
      usernames = usernames.filter((u) => !have.has(u));
    }

    // Read by the Spir engine (free, slower): accounts already in the cache are
    // read here at no cost, the rest go to an engine run for this project.
    let viaEngine = 0;
    if (usernames.length > 0 && (await getValue<string>(`job-read:${job.id}`)) === "engine") {
      const fresh =
        cacheDays > 0
          ? await db
              .select({ username: profiles.username })
              .from(profiles)
              .where(
                and(
                  inArray(profiles.username, usernames),
                  gte(profiles.fetchedAt, new Date(Date.now() - cacheDays * 86_400_000)),
                ),
              )
          : [];
      const cached = new Set(fresh.map((f) => f.username));
      const toEngine = usernames.filter((u) => !cached.has(u));
      if (toEngine.length > 0) {
        const label = await jobLabel(job.id);
        await lateApi().createEngineRun({
          name: `مهمة: ${label?.project ?? ""} ${job.sourceUrl}`.slice(0, 80),
          projectId: job.projectId,
          seeds: toEngine,
          maxDepth: 0,
          maxAccounts: toEngine.length,
        });
        viaEngine = toEngine.length;
        usernames = usernames.filter((u) => cached.has(u));
      }
    }

    await db
      .update(jobs)
      .set({
        counts: { discovered: usernames.length, ...(viaEngine ? { viaEngine } : {}) },
      })
      .where(eq(jobs.id, job.id));
    if (usernames.length === 0) {
      await finishIfComplete(job.id);
      return;
    }
    const batches: { data: EnrichPayload }[] = [];
    for (let i = 0; i < usernames.length; i += ENRICH_BATCH) {
      batches.push({ data: { jobId: job.id, usernames: usernames.slice(i, i + ENRICH_BATCH) } });
    }
    await boss.insert(QUEUES.enrich, batches);
  }

  const rowToRaw = (r: typeof profiles.$inferSelect): RawProfile => ({
    igUserId: r.igUserId,
    username: r.username,
    fullName: r.fullName,
    bio: r.bio,
    followers: r.followers,
    following: r.following,
    posts: r.posts,
    isBusiness: r.isBusiness,
    isVerified: r.isVerified,
    category: r.category,
    externalUrl: r.externalUrl,
    businessEmail: r.businessEmail,
    businessPhone: r.businessPhone,
    businessPhoneCountryCode: r.businessPhoneCountryCode,
    businessWhatsapp: r.businessWhatsapp,
    city: r.city,
  });

  function matchKeywords(p: RawProfile, keywords: string[] | null): string[] {
    if (!keywords?.length) return [];
    const text = `${p.username} ${p.fullName ?? ""} ${p.bio ?? ""}`.toLowerCase();
    return keywords.filter((k) => k.trim() && text.includes(k.trim().toLowerCase()));
  }

  async function handleEnrich(payload: EnrichPayload) {
    const [row] = await db
      .select({ job: jobs, project: projects })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .where(eq(jobs.id, payload.jobId));
    if (row?.job.status !== "running") return;
    const { job, project } = row;
    const expiresAt = new Date(Date.now() + project.retentionDays * 86_400_000);
    await loadRouterState();

    // One query each for suppressed usernames and cached profiles, instead of per account.
    const names = payload.usernames.map((u) => u.toLowerCase());
    const blocked = await suppressedHashes(
      names.map((u) => suppressionHash("username", u, pepper)),
    );
    const cached = new Map<string, typeof profiles.$inferSelect>();
    if (cacheDays > 0) {
      const fresh = await db
        .select()
        .from(profiles)
        .where(
          and(
            inArray(profiles.username, names),
            gte(profiles.fetchedAt, new Date(Date.now() - cacheDays * 86_400_000)),
          ),
        );
      for (const p of fresh) cached.set(p.username, p);
    }

    const delta = { enriched: 0, leads: 0, skipped: 0, failed: 0, cached: 0 };
    let costUsd = 0;
    const watchHits: string[] = [];
    const changed: string[] = [];
    let deferred: string[] = [];

    // Accounts not cached are read in one batch where a provider can (one Apify run).
    const prefetched = await router.getProfiles(
      names.filter((u) => !cached.has(u) && !blocked.has(suppressionHash("username", u, pepper))),
    );

    // Reading accounts one by one stays in turn, so a provider that starts
    // refusing is rested after one refusal, not hit by several at once.
    let fetchTurn: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = fetchTurn.then(fn);
      fetchTurn = run.catch(() => {});
      return run;
    };

    const enrichOne = async (username: string): Promise<"done" | "defer"> => {
      if (blocked.has(suppressionHash("username", username, pepper))) {
        delta.skipped++;
        return "done";
      }

      let profile: RawProfile;
      let provider: "graph" | "apify" | "worker";
      let quality: { engagementRate: number | null; flags: string[] };
      const hit = cached.get(username);
      const pre = prefetched.profiles.get(username);
      if (hit) {
        profile = rowToRaw(hit);
        provider = hit.fetchedBy === "upload" ? "worker" : hit.fetchedBy;
        quality = {
          engagementRate: hit.engagementRate === null ? null : Number(hit.engagementRate),
          flags: hit.qualityFlags ?? [],
        };
        delta.cached++;
      } else if (pre) {
        profile = pre.profile;
        provider = pre.provider;
        costUsd += router.unitCost(provider);
        quality = profileQuality(profile);
      } else if (prefetched.missing.has(username)) {
        // The batch read came back without it: private or gone.
        delta.skipped++;
        return "done";
      } else {
        try {
          const fetched = await inTurn(() => router.getProfile(username));
          profile = fetched.profile;
          provider = fetched.provider;
          costUsd += router.unitCost(provider);
          quality = profileQuality(profile);
        } catch (err) {
          if (err instanceof NotFoundError) {
            delta.skipped++;
            return "done";
          }
          if (err instanceof NoProviderError && router.exhausted("profile")) {
            // Every provider is resting: resume this account and the rest later instead of failing them.
            return "defer";
          }
          delta.failed++;
          return "done";
        }
      }

      const contact = await resolveContact(profile, resolveDeps);
      const contactHashes = [
        contact.email ? suppressionHash("email", contact.email, pepper) : null,
        contact.phoneE164 || contact.phoneRaw
          ? suppressionHash("phone", (contact.phoneE164 ?? contact.phoneRaw) as string, pepper)
          : null,
      ].filter((h): h is string => !!h);
      if ((await suppressedHashes(contactHashes)).size > 0) {
        delta.skipped++;
        return "done";
      }
      const changes = hit ? [] : await saveProfile(profile, provider, quality);
      const phone = contact.phoneE164 ?? contact.phoneRaw;
      if (project.skipFake && quality.flags.length >= 2 && !contact.email && !phone) {
        delta.skipped++;
        return "done";
      }
      const projectModel = (project.model as TrainedModel | null) ?? null;
      const leadValues = {
        ...(projectModel
          ? {
              winProb: predictWin(projectModel, {
                followers: profile.followers ?? null,
                engagementRate: quality.engagementRate,
                sourceCount: 1,
                isBusiness: profile.isBusiness,
                hasEmail: !!contact.email,
                hasPhone: !!phone,
                aiScore: null,
                arabic: detectLanguage(`${profile.fullName ?? ""} ${profile.bio ?? ""}`) === "ar",
                rising: false,
                qualityFlags: quality.flags.length,
              }),
            }
          : {}),
        ...(project.personas?.length
          ? { persona: assignPersona(searchTextOf(profile), project.personas) }
          : {}),
        jobId: job.id,
        email: contact.email,
        phoneE164: contact.phoneE164,
        phoneRaw: contact.phoneRaw,
        phoneCountry: contact.phoneCountry,
        contactSource: contact.contactSource,
        phoneHash: phone ? suppressionHash("phone", phone, pepper) : null,
        country: contact.phoneCountry ?? contact.countries[0] ?? null,
        expiresAt,
      };
      // Every source the account turns up in is kept: several competitors means more interest.
      const merged = sql`case when ${job.sourceUrl} = any(coalesce(${leads.sources}, '{}'::text[])) then ${leads.sources} else array_append(coalesce(${leads.sources}, '{}'::text[]), ${job.sourceUrl}) end`;
      // On conflict the lead's status and note are kept: only the data is refreshed.
      const [saved] = await db
        .insert(leads)
        .values({
          projectId: job.projectId,
          profileId: profile.igUserId,
          ...leadValues,
          sources: [job.sourceUrl],
          sourceCount: 1,
        })
        .onConflictDoUpdate({
          target: [leads.projectId, leads.profileId],
          set: {
            ...leadValues,
            country: sql`coalesce(${leadValues.country}, ${leads.country})`,
            sources: merged,
            sourceCount: sql`cardinality(${merged})`,
          },
        })
        .returning({ id: leads.id, createdAt: leads.createdAt });
      if (saved && changes.length > 0 && saved.createdAt.getTime() < Date.now() - 60_000) {
        // A lead the project already had changed since the last fetch.
        await db
          .insert(leadEvents)
          .values({ leadId: saved.id, kind: "change", text: changes.join("، ") });
        changed.push(`@${profile.username}: ${changes.join("، ")}`);
      }
      delta.enriched++;
      if (contact.email || phone) delta.leads++;
      if (matchKeywords(profile, project.watchKeywords).length) watchHits.push(profile.username);
      return "done";
    };

    // A few accounts at a time: link pages, MX checks and saves overlap instead of waiting in turn.
    const queue = [...names];
    let processed = 0;
    while (queue.length > 0) {
      if (processed > 0) {
        // Re-checked between rounds so cancelling takes effect quickly.
        const [current] = await db
          .select({ status: jobs.status })
          .from(jobs)
          .where(eq(jobs.id, job.id));
        if (current?.status !== "running") break;
      }
      const round = queue.splice(0, ENRICH_CONCURRENCY);
      const results = await Promise.all(round.map((u) => enrichOne(u)));
      processed += round.length;
      const later = round.filter((_, k) => results[k] === "defer");
      if (later.length > 0) {
        deferred = [...later, ...queue];
        break;
      }
    }

    await bump(job.id, delta);
    await addCost(job.id, costUsd);
    await saveRouterState();
    if (deferred.length > 0) {
      const waitSeconds = Math.ceil(router.nextAvailableIn("profile") / 1000) + 5;
      await boss.send(
        QUEUES.enrich,
        { jobId: job.id, usernames: deferred },
        { startAfter: waitSeconds },
      );
      await notify({
        type: "provider",
        level: "warn",
        title: `أُجّل ${deferred.length} حساباً في مهمة ${project.name}`,
        body: `كل المصادر في فترة توقف. تكمل المهمة تلقائياً بعد حوالي ${Math.ceil(waitSeconds / 60)} دقيقة.`,
        url: `/jobs/${job.id}`,
        key: `deferred:${job.id}`,
      });
    }
    if (changed.length > 0) {
      await notify({
        type: "system",
        level: "info",
        title: `تغيّرت حسابات ${changed.length} من عملائك في ${project.name}`,
        body: changed.slice(0, 15).join("\n"),
        url: `/leads?project=${project.id}`,
        key: `changes:${job.id}:${changed.length}`,
      });
    }
    if (watchHits.length > 0) {
      await notify({
        type: "system",
        level: "info",
        title: `كلمات المراقبة: ${watchHits.length} حساب في ${project.name}`,
        body: watchHits
          .slice(0, 15)
          .map((u) => `@${u}`)
          .join("، "),
        url: `/leads?project=${project.id}&job=${job.id}`,
        key: `watch:${job.id}:${watchHits[0]}`,
      });
    }
    await finishIfComplete(job.id);
  }

  /** Collects finished AI batches; returns how many jobs were updated. */
  async function collectPendingScores(): Promise<number> {
    if (!scorer) return 0;
    const pending = await db
      .select({ id: jobs.id, counts: jobs.counts })
      .from(jobs)
      .where(sql`${jobs.counts} ? 'aiBatchId'`);
    let updated = 0;
    for (const j of pending) {
      const batchId = j.counts.aiBatchId;
      if (!batchId) continue;
      const scores = await scorer.collectBatch(batchId);
      if (!scores) continue;
      await saveScores(scores);
      await notify({
        type: "ai",
        level: "ok",
        title: "اكتمل التقييم بالذكاء الاصطناعي",
        body: `قُيّم ${scores.size} حساباً`,
        url: `/jobs/${j.id}`,
        key: `ai-batch:${batchId}`,
      });
      await db
        .update(jobs)
        .set({
          counts: sql`(${jobs.counts} - 'aiBatchId') || jsonb_build_object('scored', coalesce((${jobs.counts}->>'scored')::int, 0) + ${scores.size}::int)`,
        })
        .where(eq(jobs.id, j.id));
      updated++;
      await readyToExport(j.id);
    }
    return updated;
  }

  async function handleRetention() {
    const now = new Date();
    await db.delete(leads).where(lt(leads.expiresAt, now));
    // Profiles no lead points to any more.
    await db
      .delete(profiles)
      .where(
        notExists(
          db.select({ one: sql`1` }).from(leads).where(eq(leads.profileId, profiles.igUserId)),
        ),
      );
    await db.delete(ephemeral).where(lt(ephemeral.expiresAt, now));
    await db.delete(counters).where(lt(counters.expiresAt, now));
    // Free database plans are small: keep what is still useful, drop the rest.
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    await db.delete(profileSnapshots).where(lt(profileSnapshots.at, daysAgo(180)));
    await db.delete(competitorSnapshots).where(lt(competitorSnapshots.at, daysAgo(365)));
    await db.delete(notifications).where(lt(notifications.at, daysAgo(60)));
    await db.delete(auditLog).where(lt(auditLog.at, daysAgo(180)));
    await db.delete(partnerClicks).where(lt(partnerClicks.at, daysAgo(365)));
    await db.delete(engineEvents).where(lt(engineEvents.at, daysAgo(30)));
    // Store tool runs and their datasets (competitors' ads, comments) after 90 days.
    await db.delete(toolRuns).where(lt(toolRuns.startedAt, daysAgo(90)));
    // Usage: slots for two months (the page shows this month), daily counts for a year.
    await db.delete(usageSlots).where(lt(usageSlots.day, daysAgo(62).toISOString().slice(0, 10)));
    await db.delete(usageDaily).where(lt(usageDaily.day, daysAgo(400).toISOString().slice(0, 10)));
    // Finished engine runs (and their queues) after 90 days; their leads stay in the projects.
    await db
      .delete(engineRuns)
      .where(and(isNotNull(engineRuns.finishedAt), lt(engineRuns.finishedAt, daysAgo(90))));
    await collectPendingScores();
  }

  /** Fails a job whose list could not be collected, and tells the owner. */
  async function failDiscovery(job: typeof jobs.$inferSelect, message: string) {
    await db
      .update(jobs)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
    const label = await jobLabel(job.id);
    await notify({
      type: "job",
      level: "bad",
      title: `فشلت مهمة ${label?.project ?? ""}`.trim(),
      body: `${job.sourceUrl}\n${message}`,
      url: `/jobs/${job.id}`,
      key: `job-failed:${job.id}`,
    });
  }

  /**
   * Checks background runs: those that ended are read and their accounts
   * queued for reading (each run once, even if the webhook and a poll race).
   * `runId` limits the check to one run (the provider's webhook).
   */
  async function collectDiscoveryRuns(runId?: string) {
    const pending = await db
      .select({ key: ephemeral.key, value: ephemeral.value })
      .from(ephemeral)
      .where(and(sql`${ephemeral.key} like 'discover-run:%'`, sql`${ephemeral.expiresAt} > now()`));
    let finished = 0;
    for (const row of pending) {
      const v = row.value as { runId: string; provider: ProviderId; startedAt: number };
      if (runId && v.runId !== runId) continue;
      const jobId = row.key.slice("discover-run:".length);
      const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      if (job?.status !== "running") {
        await db.delete(ephemeral).where(eq(ephemeral.key, row.key));
        continue;
      }
      let state: Awaited<ReturnType<ProviderRouter["collectEngagers"]>>;
      try {
        state = await router.collectEngagers(v.provider, v.runId, sourceFromJob(job), job.limit);
      } catch (err) {
        state = { status: "failed", error: (err as Error).message };
      }
      if (state.status === "running") continue;
      if (!(await claimOnce(`discover-done:${v.runId}`, 3 * 86_400_000))) continue;
      await db.delete(ephemeral).where(eq(ephemeral.key, row.key));
      finished++;
      if (state.status === "failed") {
        await failDiscovery(job, state.error);
        continue;
      }
      await addCost(job.id, router.unitCost(v.provider) * state.usernames.length);
      await continueDiscovery(job, state.usernames);
    }
    return finished;
  }

  /**
   * Processes queued work for up to `budgetMs`, for serverless hosts (Vercel)
   * where no long-running worker exists. Reports whether work remains.
   */
  async function drain(opts: { budgetMs: number }) {
    const deadline = Date.now() + opts.budgetMs;
    // Background runs that ended (in case the provider's webhook did not arrive).
    let processed = await collectDiscoveryRuns().catch(() => 0);
    const queues = [
      { name: QUEUES.discover, run: (d: unknown) => handleDiscover(d as DiscoverPayload) },
      { name: QUEUES.enrich, run: (d: unknown) => handleEnrich(d as EnrichPayload) },
    ];
    let idle = false;
    // Each call takes at least one job even when the budget is already spent
    // (a slow cold start, a busy machine), so a drain always makes progress.
    const overBudget = () => processed > 0 && Date.now() >= deadline;
    while (!overBudget() && !idle) {
      idle = true;
      for (const q of queues) {
        if (overBudget()) break;
        const [job] = await boss.fetch<unknown>(q.name);
        if (!job) continue;
        idle = false;
        try {
          await q.run(job.data);
          await boss.complete(q.name, job.id);
        } catch (err) {
          await boss.fail(q.name, job.id, { message: (err as Error).message });
        }
        processed++;
      }
    }
    await collectPendingScores();
    const [active] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "running"]));
    return { processed, activeJobs: active?.n ?? 0, more: !idle };
  }

  return {
    handleDiscover,
    continueDiscovery,
    rowToRaw,
    matchKeywords,
    handleEnrich,
    collectPendingScores,
    handleRetention,
    failDiscovery,
    collectDiscoveryRuns,
    drain,
  };
}

export type Collector = ReturnType<typeof createCollector>;
