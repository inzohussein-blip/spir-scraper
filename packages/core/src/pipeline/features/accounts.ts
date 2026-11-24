import { accounts, leads, people, profiles } from "@scrapers/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { linkedAccounts, parseAccountUrl } from "../../extract/index.js";
import type { Core } from "../core.js";

import type { CoreSelf } from "./context.js";

/** A lead's accounts on other platforms. */
export function accountsMethods(core: Core, _api: () => CoreSelf) {
  const { db, connectors, linkAccounts, refreshAccount } = core;

  return {
    /** A lead's person's accounts on other platforms. */
    async personAccounts(username: string) {
      const [p] = await db
        .select({ personId: profiles.personId })
        .from(profiles)
        .where(eq(profiles.username, username.replace(/^@/, "").toLowerCase()));
      if (!p?.personId) return [];
      return db
        .select()
        .from(accounts)
        .where(eq(accounts.personId, p.personId))
        .orderBy(accounts.platform, accounts.handle);
    },

    /**
     * Adds an account on another platform to a lead (pasted by the owner),
     * then reads it if a connector exists. Returns null for an address that
     * is not an account, or the account when it already belongs to someone else.
     */
    async addAccount(input: { username: string; url: string }) {
      const ref = parseAccountUrl(input.url);
      if (!ref || ref.platform === "instagram")
        return { ok: false as const, reason: "not_account" };
      const [p] = await db
        .select({ igUserId: profiles.igUserId, personId: profiles.personId })
        .from(profiles)
        .where(eq(profiles.username, input.username.replace(/^@/, "").toLowerCase()));
      if (!p) return { ok: false as const, reason: "no_lead" };
      let personId = p.personId;
      if (!personId) {
        const [person] = await db.insert(people).values({}).returning({ id: people.id });
        personId = person?.id ?? null;
        await db.update(profiles).set({ personId }).where(eq(profiles.igUserId, p.igUserId));
      }
      if (!personId) return { ok: false as const, reason: "no_lead" };
      const [existing] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.platform, ref.platform), eq(accounts.handle, ref.handle)));
      if (existing && existing.personId !== personId)
        return { ok: false as const, reason: "taken", account: existing };
      const [added] = existing ? [existing] : await linkAccounts(personId, [ref], "manual");
      if (!added) return { ok: false as const, reason: "not_account" };
      return { ok: true as const, account: await refreshAccount(added.id) };
    },

    /**
     * Reads accounts found in bios that were never read, for the platforms with
     * a connector (the daily task). YouTube's free quota covers about 10,000 a day.
     */
    async refreshPendingAccounts(limit = 200) {
      // Paid connectors (TikTok through Apify) are read only when the owner asks.
      const platforms = [...connectors.values()].filter((c) => !c.paid).map((c) => c.platform);
      if (platforms.length === 0) return 0;
      const pending = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(isNull(accounts.fetchedAt), inArray(accounts.platform, platforms)))
        .orderBy(accounts.createdAt)
        .limit(limit);
      for (const a of pending) await refreshAccount(a.id);
      return pending.length;
    },

    async removeAccount(id: string) {
      await db.delete(accounts).where(eq(accounts.id, id));
    },

    /**
     * Finds other-platform accounts in the bios and links of a project's leads
     * (no network: only what is already stored), then reads up to `read` of
     * them through the connectors. For leads collected before this existed.
     */
    async linkProjectAccounts(projectId: string, opts: { read?: number } = {}) {
      const rows = await db
        .select({
          igUserId: profiles.igUserId,
          personId: profiles.personId,
          bio: profiles.bio,
          externalUrl: profiles.externalUrl,
        })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .where(eq(leads.projectId, projectId))
        .limit(20_000);
      let found = 0;
      const toRead: string[] = [];
      for (const r of rows) {
        const refs = linkedAccounts(r.bio, r.externalUrl);
        if (refs.length === 0) continue;
        let personId = r.personId;
        if (!personId) {
          const [person] = await db.insert(people).values({}).returning({ id: people.id });
          personId = person?.id ?? null;
          await db.update(profiles).set({ personId }).where(eq(profiles.igUserId, r.igUserId));
        }
        if (!personId) continue;
        const added = await linkAccounts(personId, refs, "bio_link");
        found += added.length;
        for (const a of added) if (connectors.has(a.platform)) toRead.push(a.id);
      }
      let read = 0;
      for (const id of toRead.slice(0, opts.read ?? 50)) {
        await refreshAccount(id);
        read++;
      }
      return { leads: rows.length, found, read };
    },

    /** How many of a project's leads have an account on each platform. */
    async platformCounts(projectId: string) {
      const rows = await db
        .select({ platform: accounts.platform, n: sql<number>`count(distinct ${leads.id})::int` })
        .from(leads)
        .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
        .innerJoin(accounts, eq(accounts.personId, profiles.personId))
        .where(eq(leads.projectId, projectId))
        .groupBy(accounts.platform);
      return Object.fromEntries(rows.map((r) => [r.platform, Number(r.n)])) as Record<
        string,
        number
      >;
    },
  };
}
