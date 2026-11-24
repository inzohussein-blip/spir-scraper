import {
  accounts,
  brokerEvents,
  inboxMessages,
  jobs,
  leadEvents,
  leads,
  monitors,
  ownComments,
  ownPosts,
  partners,
  people,
  profiles,
  projects,
  suppression,
} from "@scrapers/db";
import { getTableColumns, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Core } from "../core.js";

import type { CoreSelf } from "./context.js";

/** The backup format this version writes (2 had no jobs, people or accounts). */
export const BACKUP_VERSION = 3;

/** Tables in a backup, in the order they are restored (parents first). */
const TABLES = {
  projects,
  people,
  profiles,
  accounts,
  jobs,
  suppression,
  monitors,
  leads,
  leadEvents,
  partners,
  brokerEvents,
  ownPosts,
  ownComments,
  inboxMessages,
} as const;
type TableName = keyof typeof TABLES;

export type BackupData = { version: number; createdAt: string } & {
  [K in TableName]: (typeof TABLES)[K]["$inferSelect"][];
};

/** What a restore added (rows already there are kept as they are). */
export type RestoreResult = Record<TableName, { inBackup: number; added: number }>;

type Row = Record<string, unknown>;

/** Rows from JSON back into insertable rows: known columns only, dates as Date. */
function revive(table: PgTable, rows: unknown): Row[] {
  if (!Array.isArray(rows)) return [];
  const cols = Object.entries(getTableColumns(table));
  return rows
    .filter((r): r is Row => typeof r === "object" && r !== null)
    .map((r) => {
      const out: Row = {};
      for (const [key, col] of cols) {
        if (!(key in r)) continue;
        const v = r[key];
        out[key] =
          typeof v === "string" && (col.columnType === "PgTimestamp" || col.dataType === "date")
            ? new Date(v)
            : v;
      }
      return out;
    });
}

/** The backup's text checked before anything is written. */
export function parseBackup(json: string): BackupData {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("الملف ليس نسخة احتياطية صالحة (JSON).");
  }
  const d = data as Partial<BackupData> | null;
  if (!d || typeof d !== "object" || typeof d.version !== "number" || !Array.isArray(d.projects))
    throw new Error("الملف ليس نسخة احتياطية من هذه المنصة.");
  if (d.version > BACKUP_VERSION)
    throw new Error("النسخة من إصدار أحدث من المنصة؛ حدّث المنصة أولاً.");
  return d as BackupData;
}

/** The backup copy of the owner's data. */
export function backupMethods(core: Core, _api: () => CoreSelf) {
  const { db } = core;

  /** Which of these values already exist in a column. */
  async function existing(col: PgColumn, values: unknown[]): Promise<Set<unknown>> {
    const found = new Set<unknown>();
    const uniq = [...new Set(values.filter((v) => v !== null && v !== undefined))];
    for (let i = 0; i < uniq.length; i += 1000) {
      const part = uniq.slice(i, i + 1000);
      const rows = await db
        .select({ v: col })
        .from(col.table)
        .where(inArray(col, part as never[]));
      for (const r of rows) found.add(r.v);
    }
    return found;
  }

  /** Inserts what is not there yet; returns how many rows were added. */
  async function insertNew(table: PgTable, rows: Row[]): Promise<number> {
    let added = 0;
    for (let i = 0; i < rows.length; i += 300) {
      const part = rows.slice(i, i + 300);
      const res = await db
        .insert(table)
        .values(part as never[])
        .onConflictDoNothing()
        .returning({ one: sql<number>`1` });
      added += res.length;
    }
    return added;
  }

  return {
    /** Everything needed to restore the owner's work, as plain rows (no secrets). */
    async exportBackup(): Promise<BackupData> {
      const names = Object.keys(TABLES) as TableName[];
      const rows = await Promise.all(names.map((n) => db.select().from(TABLES[n] as PgTable)));
      const out: Row = { version: BACKUP_VERSION, createdAt: new Date().toISOString() };
      names.forEach((n, i) => {
        out[n] = rows[i];
      });
      return out as BackupData;
    },

    /**
     * Restores a backup by merging: rows that are missing are added, rows
     * already there (same id) are left untouched, nothing is deleted. Rows
     * whose parent is neither in the backup nor in the database are skipped.
     * Older backups (version 2, no jobs or people) get a stand-in job per
     * collection so their leads can be restored.
     */
    async importBackup(data: BackupData): Promise<RestoreResult> {
      const result = {} as RestoreResult;
      const rows = {} as Record<TableName, Row[]>;
      for (const n of Object.keys(TABLES) as TableName[]) rows[n] = revive(TABLES[n], data[n]);

      // Older backups: one stand-in job for each collection the leads came from.
      const jobIds = new Set(rows.jobs.map((j) => j.id));
      for (const l of rows.leads) {
        if (typeof l.jobId !== "string" || jobIds.has(l.jobId)) continue;
        jobIds.add(l.jobId);
        rows.jobs.push({
          id: l.jobId,
          projectId: l.projectId,
          sourceType: "upload",
          sourceUrl: "backup",
          limit: 1,
          provider: "upload",
          status: "done",
          counts: {},
          createdAt: l.createdAt instanceof Date ? l.createdAt : new Date(),
        });
      }

      const keep = async (
        name: TableName,
        list: Row[],
        checks: { key: string; col: PgColumn; optional?: boolean }[],
      ) => {
        let out = list;
        for (const c of checks) {
          const have = await existing(
            c.col,
            out.map((r) => r[c.key]),
          );
          out = c.optional
            ? out.map((r) =>
                r[c.key] != null && !have.has(r[c.key]) ? { ...r, [c.key]: null } : r,
              )
            : out.filter((r) => have.has(r[c.key]));
        }
        result[name] = { inBackup: list.length, added: await insertNew(TABLES[name], out) };
      };

      await keep("projects", rows.projects, []);
      await keep("people", rows.people, []);
      await keep("profiles", rows.profiles, [{ key: "personId", col: people.id, optional: true }]);
      await keep("accounts", rows.accounts, [{ key: "personId", col: people.id }]);
      await keep("jobs", rows.jobs, [{ key: "projectId", col: projects.id }]);
      await keep("suppression", rows.suppression, []);
      await keep("monitors", rows.monitors, [{ key: "projectId", col: projects.id }]);
      await keep("leads", rows.leads, [
        { key: "projectId", col: projects.id },
        { key: "profileId", col: profiles.igUserId },
        { key: "jobId", col: jobs.id },
      ]);
      await keep("leadEvents", rows.leadEvents, [{ key: "leadId", col: leads.id }]);
      await keep("partners", rows.partners, []);
      await keep("brokerEvents", rows.brokerEvents, [
        { key: "leadId", col: leads.id, optional: true },
        { key: "partnerId", col: partners.id, optional: true },
      ]);
      await keep("ownPosts", rows.ownPosts, []);
      await keep("ownComments", rows.ownComments, [{ key: "mediaId", col: ownPosts.mediaId }]);
      await keep("inboxMessages", rows.inboxMessages, []);
      return result;
    },
  };
}
