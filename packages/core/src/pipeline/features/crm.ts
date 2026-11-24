import { accounts, type LeadStatus, leadEvents, leads, profiles, projects } from "@scrapers/db";
import { and, desc, eq, inArray, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import type { LeadQuery } from "../../scoring.js";
import type { Core } from "../core.js";
import { ScoringUnavailableError, STATUS_AR } from "../core.js";

import type { CoreSelf } from "./context.js";

/** The customer list: statuses, follow-ups, deals, notes, bulk changes, questions. */
export function crmMethods(core: Core, api: () => CoreSelf) {
  const { db, scorer, notify, leadsPage } = core;

  return {
    async updateProject(
      projectId: string,
      patch: {
        name?: string | undefined;
        sheetId?: string | null | undefined;
        aiCriteria?: string | null | undefined;
        retentionDays?: number | undefined;
        autoExport?: boolean | undefined;
        watchKeywords?: string[] | null | undefined;
        messageTemplate?: string | null | undefined;
        skipFake?: boolean | undefined;
      },
    ) {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (Object.keys(clean).length === 0) return api().getProject(projectId);
      const [p] = await db
        .update(projects)
        .set(clean)
        .where(eq(projects.id, projectId))
        .returning();
      return p ?? null;
    },

    /** Sets (or clears, with null) the date to remind the owner to follow up with a lead. */
    async setFollowUp(input: { projectId: string; username: string; at: Date | null }) {
      const [profile] = await db
        .select({ id: profiles.igUserId })
        .from(profiles)
        .where(eq(profiles.username, input.username.trim().replace(/^@/, "").toLowerCase()));
      if (!profile) return false;
      const updated = await db
        .update(leads)
        .set({ followUpAt: input.at })
        .where(and(eq(leads.projectId, input.projectId), eq(leads.profileId, profile.id)))
        .returning({ id: leads.id });
      if (updated[0])
        await db.insert(leadEvents).values({
          leadId: updated[0].id,
          kind: "follow_up",
          text: input.at
            ? `تذكير متابعة يوم ${input.at.toISOString().slice(0, 10)}`
            : "أُلغي تذكير المتابعة",
        });
      return updated.length > 0;
    },

    /**
     * Sends one reminder (bell + Telegram/push) listing the follow-ups that are
     * due, then clears them so each is reminded once. Customers and rejected
     * leads are skipped. Returns how many were due.
     */
    async sendDueFollowUps(now = new Date()) {
      const due = await db
        .select({
          id: leads.id,
          username: profiles.username,
          status: leads.status,
          project: projects.name,
          projectId: projects.id,
        })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .innerJoin(projects, eq(projects.id, leads.projectId))
        .where(
          and(
            isNotNull(leads.followUpAt),
            lte(leads.followUpAt, now),
            notInArray(leads.status, ["customer", "rejected"]),
          ),
        )
        .orderBy(leads.followUpAt)
        .limit(200);
      if (due.length === 0) return 0;
      const lines = due
        .slice(0, 15)
        .map((d) => `@${d.username} · ${d.project} · ${STATUS_AR[d.status] ?? d.status}`);
      if (due.length > 15) lines.push(`و${due.length - 15} غيرهم`);
      await notify({
        type: "system",
        level: "info",
        title: `حان موعد المتابعة مع ${due.length} من العملاء`,
        body: lines.join("\n"),
        url: `/leads/board?project=${due[0]?.projectId}`,
        key: `followup:${now.toISOString().slice(0, 10)}`,
      });
      await db
        .update(leads)
        .set({ followUpAt: null })
        .where(
          inArray(
            leads.id,
            due.map((d) => d.id),
          ),
        );
      return due.length;
    },

    /** Sets where the owner is with a lead (CRM status) and an optional note. */
    async setLeadStatus(input: {
      projectId: string;
      username: string;
      status: LeadStatus;
      note?: string | null;
    }) {
      const [profile] = await db
        .select({ id: profiles.igUserId })
        .from(profiles)
        .where(eq(profiles.username, input.username.trim().replace(/^@/, "").toLowerCase()));
      if (!profile) return false;
      const updated = await db
        .update(leads)
        .set({
          status: input.status,
          statusAt: new Date(),
          ...(input.note !== undefined ? { statusNote: input.note?.slice(0, 500) ?? null } : {}),
        })
        .where(and(eq(leads.projectId, input.projectId), eq(leads.profileId, profile.id)))
        .returning({ id: leads.id });
      if (updated[0])
        await db.insert(leadEvents).values({
          leadId: updated[0].id,
          kind: "status",
          text: `الحالة: ${STATUS_AR[input.status] ?? input.status}${input.note ? ` · ${input.note.slice(0, 200)}` : ""}`,
        });
      return updated.length > 0;
    },

    /**
     * Records a closed deal: the lead becomes a customer and its value is
     * credited to every source it was found in (see sourcePerformance).
     * A null value clears the deal.
     */
    async setDeal(input: { projectId: string; username: string; value: number | null; at?: Date }) {
      const u = input.username.trim().replace(/^@/, "").toLowerCase();
      const [profile] = await db
        .select({ id: profiles.igUserId })
        .from(profiles)
        .where(eq(profiles.username, u));
      if (!profile) return false;
      const value = input.value === null ? null : Math.max(0, Math.round(input.value * 100) / 100);
      const at = input.at ?? new Date();
      const updated = await db
        .update(leads)
        .set(
          value === null
            ? { dealValue: null, dealAt: null }
            : {
                dealValue: value.toFixed(2),
                dealAt: at,
                status: "customer",
                statusAt: sql`coalesce(${leads.statusAt}, ${at.toISOString()}::timestamptz)`,
                followUpAt: null,
              },
        )
        .where(and(eq(leads.projectId, input.projectId), eq(leads.profileId, profile.id)))
        .returning({ id: leads.id });
      if (updated[0])
        await db.insert(leadEvents).values({
          leadId: updated[0].id,
          kind: "status",
          text: value === null ? "أُلغيت الصفقة" : `صفقة بقيمة ${value.toLocaleString("en")}$`,
        });
      return updated.length > 0;
    },

    /** Changes many leads at once: status, follow-up date, or both. Returns how many changed. */
    async bulkUpdateLeads(input: {
      projectId: string;
      usernames: string[];
      status?: LeadStatus;
      followUpAt?: Date | null;
    }) {
      const names = [
        ...new Set(input.usernames.map((u) => u.replace(/^@/, "").toLowerCase())),
      ].slice(0, 500);
      if (names.length === 0 || (input.status === undefined && input.followUpAt === undefined))
        return 0;
      const ids = db
        .select({ id: profiles.igUserId })
        .from(profiles)
        .where(inArray(profiles.username, names));
      const updated = await db
        .update(leads)
        .set({
          ...(input.status ? { status: input.status, statusAt: new Date() } : {}),
          ...(input.followUpAt !== undefined ? { followUpAt: input.followUpAt } : {}),
        })
        .where(and(eq(leads.projectId, input.projectId), inArray(leads.profileId, ids)))
        .returning({ id: leads.id });
      const text = [
        input.status ? `الحالة: ${STATUS_AR[input.status] ?? input.status}` : "",
        input.followUpAt !== undefined
          ? input.followUpAt
            ? `تذكير متابعة يوم ${input.followUpAt.toISOString().slice(0, 10)}`
            : "أُلغي تذكير المتابعة"
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      if (updated.length > 0)
        await db
          .insert(leadEvents)
          .values(updated.map((u) => ({ leadId: u.id, kind: "status", text: `${text} (جماعي)` })));
      return updated.length;
    },

    /** Adds the owner's note to a lead's history. */
    async addLeadNote(input: { projectId: string; username: string; text: string }) {
      const text = input.text.trim().slice(0, 2000);
      if (!text) return false;
      const [row] = await db
        .select({ id: leads.id })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(
          and(
            eq(leads.projectId, input.projectId),
            eq(profiles.username, input.username.replace(/^@/, "").toLowerCase()),
          ),
        );
      if (!row) return false;
      await db.insert(leadEvents).values({ leadId: row.id, kind: "note", text });
      return true;
    },

    /** A lead with its notes and history, newest first. */
    async leadDetail(projectId: string, username: string) {
      const u = username.replace(/^@/, "").toLowerCase();
      const [row] = await leadsPage({ projectId, q: u, limit: 20 }).then((r) =>
        r.leads.filter((l) => l.username === u),
      );
      if (!row) return null;
      const events = await db
        .select({ at: leadEvents.at, kind: leadEvents.kind, text: leadEvents.text })
        .from(leadEvents)
        .innerJoin(leads, eq(leads.id, leadEvents.leadId))
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(and(eq(leads.projectId, projectId), eq(profiles.username, u)))
        .orderBy(desc(leadEvents.at))
        .limit(100);
      const [p] = await db
        .select({ bio: profiles.bio })
        .from(profiles)
        .where(eq(profiles.username, u));
      const [pp] = await db
        .select({ personId: profiles.personId })
        .from(profiles)
        .where(eq(profiles.username, u));
      const accs = pp?.personId
        ? await db
            .select()
            .from(accounts)
            .where(eq(accounts.personId, pp.personId))
            .orderBy(accounts.platform, accounts.handle)
        : [];
      return { lead: row, bio: p?.bio ?? null, events, accounts: accs };
    },

    /** Understands a question in plain language and returns the matching leads. */
    async askLeads(projectId: string, question: string, limit = 50) {
      if (!scorer?.parseQuery)
        throw new ScoringUnavailableError("Questions in plain language need ANTHROPIC_API_KEY");
      const query: LeadQuery = await scorer.parseQuery(question);
      const page = await leadsPage({ ...query, projectId, limit });
      return { query, leads: page.leads };
    },

    /** Leads with a follow-up date, for the calendar feed. */
    async upcomingFollowUps(limit = 500) {
      return db
        .select({
          username: profiles.username,
          fullName: profiles.fullName,
          at: leads.followUpAt,
          status: leads.status,
          project: projects.name,
          projectId: projects.id,
          note: leads.statusNote,
        })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .innerJoin(projects, eq(projects.id, leads.projectId))
        .where(isNotNull(leads.followUpAt))
        .orderBy(leads.followUpAt)
        .limit(limit);
    },

    async leadStatusCounts(projectId: string) {
      const rows = await db
        .select({ status: leads.status, n: sql<number>`count(*)::int` })
        .from(leads)
        .where(eq(leads.projectId, projectId))
        .groupBy(leads.status);
      return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<
        Record<LeadStatus, number>
      >;
    },
  };
}
