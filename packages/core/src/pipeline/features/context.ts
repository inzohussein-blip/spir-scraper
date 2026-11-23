import type { AnyDb } from "@scrapers/db";
import type { NotificationInput } from "../../notify.js";
import type { Scorer } from "../../scoring.js";
import type { OwnAccount, Source } from "../../types.js";

/**
 * What a feature module needs from the service: the database, shared helpers
 * and, through `self()`, the few service methods it calls. Feature modules
 * keep pipeline/service.ts from growing without end.
 */
export interface FeatureContext {
  db: AnyDb;
  deps: { own?: OwnAccount | undefined };
  scorer: Scorer | undefined;
  pepper: string;
  notify(n: NotificationInput): Promise<boolean>;
  getValue<T>(key: string): Promise<T | null>;
  setValue(key: string, value: unknown, ttlMs: number): Promise<void>;
  refreshDealFromBroker(leadId: string): Promise<unknown>;
  self(): FeatureSelf;
}

/** Service methods the feature modules call. */
export interface FeatureSelf {
  audit(entry: {
    actor: string;
    action: string;
    detail?: Record<string, unknown>;
    ip?: string | null;
  }): Promise<unknown>;
  startJob(input: {
    projectId: string;
    source: Source;
    limit: number;
  }): Promise<{ job: { id: string } }>;
  sourcePerformance(
    projectId: string,
  ): Promise<{ sources: { source: string; leads: number; customers: number; revenue: number }[] }>;
  getProject(projectId: string): Promise<
    | {
        aiCriteria: string | null;
        personas: { name: string; description: string; keywords: string[] }[] | null;
      }
    | null
    | undefined
  >;
  ownPostPerformance(projectId: string): Promise<
    {
      caption: string | null;
      type: string | null;
      intentComments: number | null;
      revenue: number;
    }[]
  >;
}
