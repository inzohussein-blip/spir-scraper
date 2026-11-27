import { accounts, leads, profiles } from "@scrapers/db";
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  type ContactSource,
  extractContact,
  findEmails,
  findPhones,
  INFLUENCER_FOLLOWERS,
  isLinkPage,
  isPlausibleEmail,
  parseAccountUrl,
} from "../../extract/index.js";
import { suppressionHash } from "../../suppression.js";
import type { RawProfile } from "../../types.js";
import type { Core } from "../core.js";
import type { CoreSelf } from "./context.js";

/** A deep search is not repeated for the same account within this many days. */
export const CONTACT_RECHECK_DAYS = 30;
/** Apify's profile reader, per 1,000 accounts (Store price), for the cost estimate. */
export const REREAD_COST_PER_1K = 1.6;

export type DeepContactInput = {
  projectId?: string;
  jobId?: string;
  /** The most accounts to look at in this call. */
  limit?: number;
  /** Also read the accounts again through Apify (paid) for their contact button. */
  reread?: boolean;
  /** Stop starting new accounts after this long (a serverless call has a time limit). */
  budgetMs?: number;
};

export type DeepContactResult = {
  checked: number;
  found: number;
  emails: number;
  phones: number;
  bySource: Partial<Record<ContactSource, number>>;
  reread: number;
  costUsd: number;
  /** Accounts still waiting for a search (run again to continue). */
  remaining: number;
};

type Found = { email: string | null; phone: string | null; source: ContactSource };

/**
 * A second, deeper search for the email and number of leads that have
 * neither: their own website (home, contact and about pages), the bios of
 * their accounts on other platforms, and optionally a second read of their
 * profile through Apify, whose reader returns the public contact button more
 * often than an anonymous read. Only business, verified and large accounts
 * are searched (the same rule as the first read), only public information is
 * used, and the do-not-contact list is respected.
 */
export function contactsMethods(core: Core, _api: () => CoreSelf) {
  const { db, deps, pepper, resolveDeps, suppressedHashes, getValue } = core;
  const tools = deps.tools ?? {};

  const noContact = and(isNull(leads.email), isNull(leads.phoneE164), isNull(leads.phoneRaw));
  const eligible = or(
    eq(profiles.isBusiness, true),
    eq(profiles.isVerified, true),
    gte(profiles.followers, INFLUENCER_FOLLOWERS),
  );
  const due = or(
    isNull(profiles.contactCheckedAt),
    lt(profiles.contactCheckedAt, sql`now() - make_interval(days => ${CONTACT_RECHECK_DAYS})`),
  );

  /** Profiles with a lead (in this project or job) that has no email or number yet. */
  function scope(input: { projectId?: string; jobId?: string }) {
    const withoutContact = db
      .select({ id: leads.profileId })
      .from(leads)
      .where(
        and(
          noContact,
          input.projectId ? eq(leads.projectId, input.projectId) : undefined,
          input.jobId ? eq(leads.jobId, input.jobId) : undefined,
        ),
      );
    return and(inArray(profiles.igUserId, withoutContact), eligible, due);
  }

  async function countDue(input: { projectId?: string; jobId?: string }) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(profiles)
      .where(scope(input));
    return row?.n ?? 0;
  }

  /** The first plausible email and parseable number in some public text. */
  function fromText(texts: (string | null | undefined)[], countries: string[]) {
    const text = texts.filter(Boolean).join("\n");
    const email = findEmails(text).find(isPlausibleEmail) ?? null;
    const phone = findPhones(text, countries as never[])[0];
    return { email, phone: phone?.e164 ?? phone?.raw ?? null };
  }

  async function search(
    p: typeof profiles.$inferSelect,
    reread: Map<string, RawProfile>,
  ): Promise<Found | null> {
    const countries = extractContact(p as unknown as RawProfile).countries;

    // 1. A second read of the profile (its public contact button, bio and link).
    const again = reread.get(p.username.toLowerCase());
    if (again) {
      const c = extractContact(again);
      if (c.email || c.phoneE164 || c.phoneRaw)
        return {
          email: c.email,
          phone: c.phoneE164 ?? c.phoneRaw,
          source: c.contactSource ?? "business_button",
        };
    }

    // 2. Their own website: home, contact and about pages.
    const url = again?.externalUrl ?? p.externalUrl;
    if (
      url &&
      tools.siteContacts &&
      !isLinkPage(url) &&
      parseAccountUrl(url)?.platform === "website"
    ) {
      const site = await tools.siteContacts(url).catch(() => null);
      if (site) {
        const f = fromText([...site.emails, ...site.phones], countries);
        if (f.email || f.phone) return { ...f, source: "website" };
      }
    }

    // 3. Their accounts on other platforms (YouTube and Telegram descriptions often hold a business email).
    if (p.personId) {
      const other = await db
        .select({ bio: accounts.bio, name: accounts.displayName })
        .from(accounts)
        .where(eq(accounts.personId, p.personId));
      const f = fromText(
        other.flatMap((a) => [a.bio, a.name]),
        countries,
      );
      if (f.email || f.phone) return { ...f, source: "account" };
    }
    return null;
  }

  return {
    /** How many leads could still get a deep contact search (no email or number yet). */
    async deepContactCandidates(input: { projectId?: string; jobId?: string } = {}) {
      return countDue(input);
    },

    async deepContactSearch(input: DeepContactInput = {}): Promise<DeepContactResult> {
      const started = Date.now();
      const budget = input.budgetMs ?? 200_000;
      const limit = Math.min(Math.max(1, input.limit ?? 40), 500);
      // Largest accounts first: they are the likeliest to publish a contact.
      const list = await db
        .select()
        .from(profiles)
        .where(scope(input))
        .orderBy(sql`${profiles.followers} desc nulls last`)
        .limit(limit);
      const result: DeepContactResult = {
        checked: 0,
        found: 0,
        emails: 0,
        phones: 0,
        bySource: {},
        reread: 0,
        costUsd: 0,
        remaining: 0,
      };

      // One batch through the second reader, for accounts it has not read before.
      const reread = new Map<string, RawProfile>();
      if (input.reread && tools.rereadProfiles && list.length > 0) {
        const names = list.filter((p) => p.fetchedBy !== "apify").map((p) => p.username);
        if (names.length > 0) {
          const got = await tools.rereadProfiles(names).catch(() => [] as RawProfile[]);
          for (const r of got) reread.set(r.username.toLowerCase(), r);
          result.reread = names.length;
          result.costUsd = (names.length / 1000) * REREAD_COST_PER_1K;
        }
      }

      const queue = [...list];
      const worker = async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          if (Date.now() - started > budget) {
            queue.unshift(p);
            return;
          }
          result.checked++;
          let found = await search(p, reread).catch(() => null);
          // An email whose domain cannot receive mail is dropped.
          if (found?.email && resolveDeps.checkEmail) {
            const status = await resolveDeps.checkEmail(found.email).catch(() => "unknown");
            if (status === "invalid") found = found.phone ? { ...found, email: null } : null;
          }
          if (found) {
            const hashes = [
              found.email ? suppressionHash("email", found.email, pepper) : null,
              found.phone ? suppressionHash("phone", found.phone, pepper) : null,
            ].filter((h): h is string => !!h);
            if ((await suppressedHashes(hashes)).size > 0) found = null;
          }
          if (found) {
            const e164 = found.phone?.startsWith("+") ? found.phone : null;
            await db
              .update(leads)
              .set({
                email: found.email,
                phoneE164: e164,
                phoneRaw: found.phone && !e164 ? found.phone : null,
                contactSource: found.source,
                phoneHash: found.phone ? suppressionHash("phone", found.phone, pepper) : null,
              })
              .where(and(eq(leads.profileId, p.igUserId), noContact));
            result.found++;
            if (found.email) result.emails++;
            if (found.phone) result.phones++;
            result.bySource[found.source] = (result.bySource[found.source] ?? 0) + 1;
          }
          await db
            .update(profiles)
            .set({ contactCheckedAt: new Date() })
            .where(eq(profiles.igUserId, p.igUserId));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      result.remaining = await countDue(input);
      return result;
    },

    /** What the automatic deep search found after a job (null when it did not run). */
    async jobDeepResult(jobId: string) {
      return getValue<DeepContactResult>(`job-deep-result:${jobId}`);
    },

    /** Leads of a job that already have an email or a number, for the job page. */
    async jobContactCounts(jobId: string) {
      const [row] = await db
        .select({
          total: sql<number>`count(*)::int`,
          email: sql<number>`count(${leads.email})::int`,
          phone: sql<number>`count(coalesce(${leads.phoneE164}, ${leads.phoneRaw}))::int`,
        })
        .from(leads)
        .where(eq(leads.jobId, jobId));
      return row ?? { total: 0, email: 0, phone: 0 };
    },
  };
}
