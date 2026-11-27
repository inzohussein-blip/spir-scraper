import {
  type Core,
  createCore,
  type DiscoverPayload,
  type EnrichPayload,
  type LeadFilters,
  type LeadRow,
  QUEUES,
  type ScrapersDeps,
} from "./core.js";
import { accountsMethods } from "./features/accounts.js";
import { backupMethods } from "./features/backup.js";
import { brokerMethods } from "./features/broker.js";
import { competitorsMethods } from "./features/competitors.js";
import { contactsMethods } from "./features/contacts.js";
import type { CoreSelf, FeatureContext } from "./features/context.js";
import { crmMethods } from "./features/crm.js";
import { engineMethods } from "./features/engine.js";
import { insightsMethods } from "./features/insights.js";
import { jobsMethods } from "./features/jobs.js";
import { marketMethods } from "./features/market.js";
import { opsMethods } from "./features/ops.js";
import { ownMethods } from "./features/own.js";
import { placesMethods } from "./features/places.js";
import { saverMethods } from "./features/saver.js";
import { systemMethods } from "./features/system.js";
import { toolsMethods } from "./features/tools.js";
import { usageMethods } from "./features/usage.js";

export * from "./core.js";

export function createScrapers(deps: ScrapersDeps) {
  const core: Core = createCore(deps);
  const {
    db,
    boss,
    config,
    scorer,
    connectors,
    pepper,
    getValue,
    setValue,
    claimOnce,
    hitCounter,
    notify,
    maxLimit,
    saveProfile,
    handleDiscover,
    handleEnrich,
    handleRetention,
    refreshAccount,
    refreshDealFromBroker,
    scoreJob,
    leadsPage,
    collectDiscoveryRuns,
    drain,
  } = core;

  // Feature modules get the shared helpers and call other service methods through self().
  const featureCtx: FeatureContext = {
    db,
    deps,
    scorer,
    pepper,
    notify,
    getValue,
    setValue,
    refreshDealFromBroker,
    saveProfile,
    timeZone: config.timeZone ?? "Asia/Baghdad",
    connectors,
    maxJobLimit: maxLimit,
    self: () => api,
  };

  const self = (): CoreSelf => api;
  const api = {
    ...jobsMethods(core, self),
    ...crmMethods(core, self),
    ...insightsMethods(core, self),
    ...accountsMethods(core, self),
    ...competitorsMethods(core, self),
    ...backupMethods(core, self),
    ...systemMethods(core, self),
    ...toolsMethods(core, self),
    ...contactsMethods(core, self),
    async init() {
      await boss.createQueue(QUEUES.discover, {
        retryLimit: 2,
        retryBackoff: true,
        retryDelay: 30,
      });
      await boss.createQueue(QUEUES.enrich, { retryLimit: 3, retryBackoff: true, retryDelay: 30 });
      await boss.createQueue(QUEUES.retention);
    },

    /** Starts consuming queues. Call once per worker process. */
    async work(opts: { pollingIntervalSeconds?: number } = {}) {
      const polling = { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 };
      await boss.work<DiscoverPayload>(QUEUES.discover, polling, async ([job]) => {
        if (job) await handleDiscover(job.data);
      });
      await boss.work<EnrichPayload>(
        QUEUES.enrich,
        { ...polling, localConcurrency: 1 },
        async ([job]) => {
          if (job) await handleEnrich(job.data);
        },
      );
      await boss.work(QUEUES.retention, polling, async () => handleRetention());
      await boss.schedule(QUEUES.retention, "17 3 * * *");
    },

    listLeads: async (f: LeadFilters): Promise<LeadRow[]> => (await leadsPage(f)).leads,

    /** One page of leads with a cursor for the next page. */
    listLeadsPage: (f: LeadFilters) => leadsPage(f),

    drain,
    collectDiscoveryRuns,
    notify,
    getValue,
    setValue,
    claimOnce,
    hitCounter,

    ...placesMethods(featureCtx),

    refreshAccount,

    ...brokerMethods(featureCtx),

    ...ownMethods(featureCtx),

    ...marketMethods(featureCtx),

    ...engineMethods(featureCtx),

    ...opsMethods(featureCtx),

    ...usageMethods(featureCtx),

    ...saverMethods(featureCtx),

    /**
     * Scores a job's leads with the AI layer. Small jobs are scored now;
     * large ones are submitted as a batch and collected by drain/retention.
     */
    scoreLeads: (jobId: string, criteria: string, opts: { rescore?: boolean } = {}) =>
      scoreJob(jobId, criteria, opts),

    /** Exposed for tests and for running the pipeline without pg-boss workers. */
    handlers: { discover: handleDiscover, enrich: handleEnrich, retention: handleRetention },
  };
  core.bindApi(api);
  return api;
}

export type Scrapers = ReturnType<typeof createScrapers>;
