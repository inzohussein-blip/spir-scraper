import { type Collector, createCollector } from "./core-collect.js";
import { createLeadStore, type LeadStore } from "./core-leads.js";
import { createStore, type Store } from "./core-store.js";
import type { ScrapersDeps } from "./shared.js";

export * from "./shared.js";

/**
 * The pipeline's internals, built in layers (each uses the ones before it):
 * core-store.ts (stores, notifications, job costs), core-leads.ts (profiles,
 * accounts, the own model, scoring, lead pages) and core-collect.ts
 * (discovery, enrichment, retention, the serverless drain). The public
 * methods live in features/*.ts.
 */
export function createCore(deps: ScrapersDeps) {
  const store = createStore(deps);
  const leads = createLeadStore(deps, store);
  const collect = createCollector(deps, { ...store, ...leads });
  const { db, boss, router, config, scorer } = deps;
  const all: Store & LeadStore & Collector = { ...store, ...leads, ...collect };
  return { deps, db, boss, router, config, scorer, ...all };
}

export type Core = ReturnType<typeof createCore>;
