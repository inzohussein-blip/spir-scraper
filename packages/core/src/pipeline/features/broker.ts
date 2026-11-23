import { createHash, randomBytes } from "node:crypto";
import { brokerEvents, leads, partnerClicks, partners, profiles } from "@scrapers/db";
import { and, desc, eq, gte, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { BrokerEventInput } from "../../broker.js";
import { suppressionHash } from "../../suppression.js";
import type { FeatureContext } from "./context.js";

/** Broker reports (postback and CSV) and the partner network. */
export function brokerMethods(ctx: FeatureContext) {
  const { db, pepper, notify, refreshDealFromBroker } = ctx;

  return {
    /**
     * Stores what the broker reported and matches each event to a lead (by
     * email or phone, newest lead first) and to a partner (by the sub id in
     * the tracking link). Matched deposits and commissions update the lead's
     * deal; the same report line sent twice is stored once.
     */
    async ingestBrokerEvents(events: BrokerEventInput[], source: "postback" | "csv") {
      let stored = 0;
      let matched = 0;
      let duplicates = 0;
      const touched = new Set<string>();
      const partnerByCode = new Map(
        (await db.select({ id: partners.id, code: partners.code }).from(partners)).map((x) => [
          x.code.toLowerCase(),
          x.id,
        ]),
      );
      for (const e of events) {
        const phoneHash = e.phone ? suppressionHash("phone", e.phone, pepper) : null;
        const emailHash = e.email ? suppressionHash("email", e.email, pepper) : null;
        let leadId: string | null = null;
        if (e.email || phoneHash) {
          const [lead] = await db
            .select({ id: leads.id })
            .from(leads)
            .where(
              or(
                e.email ? sql`lower(${leads.email}) = ${e.email.toLowerCase()}` : undefined,
                phoneHash ? eq(leads.phoneHash, phoneHash) : undefined,
              ),
            )
            .orderBy(desc(leads.createdAt))
            .limit(1);
          leadId = lead?.id ?? null;
        }
        const partnerId = e.sub ? (partnerByCode.get(e.sub.toLowerCase()) ?? null) : null;
        const dedupeKey = createHash("sha256")
          .update(
            [
              e.event,
              e.externalId ?? emailHash ?? phoneHash ?? "",
              e.amount ?? "",
              e.at?.toISOString() ?? "",
              e.sub ?? "",
            ].join("|"),
          )
          .digest("hex");
        const [row] = await db
          .insert(brokerEvents)
          .values({
            event: e.event,
            externalId: e.externalId,
            emailHash,
            phoneHash,
            amount: e.amount === null ? null : e.amount.toFixed(2),
            currency: e.currency,
            sub: e.sub,
            leadId,
            partnerId,
            source,
            dedupeKey,
            ...(e.at ? { at: e.at } : {}),
          })
          .onConflictDoNothing({ target: brokerEvents.dedupeKey })
          .returning({ id: brokerEvents.id });
        if (!row) {
          duplicates++;
          continue;
        }
        stored++;
        if (leadId) {
          matched++;
          touched.add(leadId);
        }
      }
      for (const id of touched) await refreshDealFromBroker(id);
      if (stored > 0)
        await notify({
          type: "system",
          level: "ok",
          title: `وصل من الوسيط ${stored} حدثاً`,
          body: `طوبق منها ${matched} مع عملائك${duplicates ? ` · ${duplicates} مكرر` : ""}`,
          url: "/insights",
          key: `broker:${new Date().toISOString().slice(0, 13)}`,
        });
      return { stored, matched, duplicates };
    },

    /** Totals of what the broker reported, and how much of it matched a lead. */
    async brokerSummary(opts: { since?: Date } = {}) {
      const rows = await db
        .select({
          event: brokerEvents.event,
          n: sql<number>`count(*)::int`,
          matched: sql<number>`count(${brokerEvents.leadId})::int`,
          amount: sql<string>`coalesce(sum(${brokerEvents.amount}), 0)`,
        })
        .from(brokerEvents)
        .where(opts.since ? gte(brokerEvents.at, opts.since) : undefined)
        .groupBy(brokerEvents.event);
      const last = await db
        .select({
          at: brokerEvents.at,
          event: brokerEvents.event,
          amount: brokerEvents.amount,
          matched: brokerEvents.leadId,
        })
        .from(brokerEvents)
        .orderBy(desc(brokerEvents.at))
        .limit(10);
      return {
        byEvent: Object.fromEntries(
          rows.map((r) => [
            r.event,
            { count: Number(r.n), matched: Number(r.matched), amount: Number(r.amount) },
          ]),
        ) as Record<string, { count: number; matched: number; amount: number }>,
        last: last.map((l) => ({
          ...l,
          matched: !!l.matched,
          amount: l.amount === null ? null : Number(l.amount),
        })),
      };
    },

    // ---- partner network ----
    async createPartner(input: {
      name: string;
      instagram?: string | null;
      sharePercent?: number;
      code?: string;
    }) {
      const code = (input.code?.trim().toLowerCase() || randomBytes(4).toString("hex"))
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 24);
      if (code.length < 3) throw new Error("الكود قصير جداً");
      const [p] = await db
        .insert(partners)
        .values({
          name: input.name.trim().slice(0, 100),
          code,
          instagram: input.instagram?.replace(/^@/, "").toLowerCase() || null,
          sharePercent: Math.min(100, Math.max(0, Math.round(input.sharePercent ?? 0))),
          portalToken: randomBytes(18).toString("base64url"),
        })
        .returning();
      if (!p) throw new Error("Partner insert returned nothing");
      // Events that arrived with this code before the partner existed belong to them.
      await db
        .update(brokerEvents)
        .set({ partnerId: p.id })
        .where(and(isNull(brokerEvents.partnerId), sql`lower(${brokerEvents.sub}) = ${code}`));
      return p;
    },

    async updatePartner(
      id: string,
      patch: { active?: boolean; sharePercent?: number; name?: string },
    ) {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (Object.keys(clean).length)
        await db.update(partners).set(clean).where(eq(partners.id, id));
    },

    async partnerByCode(code: string) {
      const [p] = await db.select().from(partners).where(eq(partners.code, code.toLowerCase()));
      return p ?? null;
    },

    async partnerByToken(token: string) {
      const [p] = await db.select().from(partners).where(eq(partners.portalToken, token));
      return p ?? null;
    },

    async recordClick(partnerId: string) {
      await db.insert(partnerClicks).values({ partnerId });
    },

    /**
     * Each partner's clicks and what the broker reported for their code:
     * registrations, first deposits, deposit total, commission, and their share.
     */
    async partnerStats(opts: { partnerId?: string; since?: Date } = {}) {
      const list = await db
        .select()
        .from(partners)
        .where(opts.partnerId ? eq(partners.id, opts.partnerId) : undefined)
        .orderBy(desc(partners.createdAt));
      const clicks = await db
        .select({ partnerId: partnerClicks.partnerId, n: sql<number>`count(*)::int` })
        .from(partnerClicks)
        .where(opts.since ? gte(partnerClicks.at, opts.since) : undefined)
        .groupBy(partnerClicks.partnerId);
      const ev = await db
        .select({
          partnerId: brokerEvents.partnerId,
          registrations: sql<number>`count(*) filter (where ${brokerEvents.event} = 'registration')::int`,
          ftds: sql<number>`count(*) filter (where ${brokerEvents.event} = 'ftd')::int`,
          deposits: sql<string>`coalesce(sum(${brokerEvents.amount}) filter (where ${brokerEvents.event} in ('ftd', 'deposit')), 0)`,
          commission: sql<string>`coalesce(sum(${brokerEvents.amount}) filter (where ${brokerEvents.event} = 'commission'), 0)`,
        })
        .from(brokerEvents)
        .where(
          and(
            isNotNull(brokerEvents.partnerId),
            opts.since ? gte(brokerEvents.at, opts.since) : undefined,
          ),
        )
        .groupBy(brokerEvents.partnerId);
      return list.map((p) => {
        const c = clicks.find((x) => x.partnerId === p.id);
        const e = ev.find((x) => x.partnerId === p.id);
        const commission = Number(e?.commission ?? 0);
        return {
          ...p,
          clicks: Number(c?.n ?? 0),
          registrations: Number(e?.registrations ?? 0),
          ftds: Number(e?.ftds ?? 0),
          deposits: Number(e?.deposits ?? 0),
          commission,
          partnerShare: Math.round(commission * p.sharePercent) / 100,
        };
      });
    },

    /**
     * Who to invite as a partner: leads with an audience (5k+ followers) that
     * engage it, ranked by growth, the project's model and AI score.
     */
    async recruitCandidates(projectId: string, limit = 15) {
      const taken = new Set(
        (await db.select({ ig: partners.instagram }).from(partners))
          .map((x) => x.ig)
          .filter(Boolean),
      );
      const rows = await db
        .select({
          username: profiles.username,
          fullName: profiles.fullName,
          followers: profiles.followers,
          engagementRate: profiles.engagementRate,
          signals: profiles.signals,
          persona: leads.persona,
          winProb: leads.winProb,
          aiScore: leads.aiScore,
          status: leads.status,
        })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(
          and(
            eq(leads.projectId, projectId),
            gte(profiles.followers, 5000),
            ne(leads.status, "rejected"),
          ),
        )
        .limit(500);
      const score = (r: (typeof rows)[number]) =>
        Math.log10(1 + (r.followers ?? 0)) * 10 +
        Math.min(Number(r.engagementRate ?? 0), 10) * 3 +
        (r.signals?.includes("rising") ? 15 : 0) +
        (r.winProb ?? 0) * 0.3 +
        (r.aiScore ?? 0) * 0.2;
      return rows
        .filter((r) => !taken.has(r.username))
        .map((r) => ({
          ...r,
          engagementRate: r.engagementRate === null ? null : Number(r.engagementRate),
          rank: Math.round(score(r)),
        }))
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit);
    },
  };
}
