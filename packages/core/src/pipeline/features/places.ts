import { createHash } from "node:crypto";
import { places, siteWatches } from "@scrapers/db";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { normalizePageText, pageDiff, parseAccountUrl } from "../../extract/index.js";
import type { FeatureContext } from "./context.js";

/** Businesses on Google Maps (their sites and Instagram pages) and watched competitor sites. */
export function placesMethods(ctx: FeatureContext) {
  const { db, deps, notify, connectors, self } = ctx;

  return {
    /** Whether Google Maps search is configured (needs APIFY_TOKEN). */
    get placesAvailable() {
      return !!deps.places;
    },

    /**
     * Searches Google Maps and keeps the businesses in the project (a business
     * found again is updated, not duplicated). The cost is estimated from the
     * provider's price and returned.
     */
    async searchPlaces(input: {
      projectId: string;
      query: string;
      location: string;
      limit?: number;
    }) {
      if (!deps.places) throw new Error("البحث في خرائط جوجل يحتاج APIFY_TOKEN");
      const limit = Math.min(Math.max(1, input.limit ?? 30), 200);
      const found = await deps.places.searchPlaces(
        input.query.trim(),
        input.location.trim(),
        limit,
      );
      const label = `${input.query.trim()} · ${input.location.trim()}`;
      let saved = 0;
      for (const f of found) {
        const values = {
          name: f.name.slice(0, 300),
          category: f.category ?? null,
          address: f.address ?? null,
          city: f.city ?? null,
          country: f.country && /^[A-Z]{2}$/.test(f.country) ? f.country : null,
          phone: f.phone ?? null,
          website: f.website ?? null,
          rating: f.rating === null || f.rating === undefined ? null : f.rating.toFixed(1),
          reviews: f.reviews ?? null,
          url: f.url ?? null,
        };
        await db
          .insert(places)
          .values({ projectId: input.projectId, placeId: f.placeId, query: label, ...values })
          .onConflictDoUpdate({ target: [places.projectId, places.placeId], set: values });
        saved++;
      }
      return {
        found: saved,
        costUsd: Math.round(((deps.places.placesCostPer1k * found.length) / 1000) * 10000) / 10000,
      };
    },

    async listPlaces(projectId: string, opts: { query?: string; limit?: number } = {}) {
      return db
        .select()
        .from(places)
        .where(
          and(
            eq(places.projectId, projectId),
            opts.query ? eq(places.query, opts.query) : undefined,
          ),
        )
        .orderBy(desc(places.createdAt))
        .limit(Math.min(opts.limit ?? 500, 2000));
    },

    async placeQueries(projectId: string) {
      const rows = await db
        .select({ query: places.query, n: sql<number>`count(*)::int` })
        .from(places)
        .where(eq(places.projectId, projectId))
        .groupBy(places.query);
      return rows.map((r) => ({ query: r.query, count: Number(r.n) }));
    },

    /**
     * Reads the websites of businesses not analysed yet (contact, about and
     * partner pages) for their Instagram account and emails.
     */
    async analyzePlaces(projectId: string, limit = 20) {
      const reader = connectors.get("website");
      if (!reader) return { analyzed: 0, instagram: 0 };
      const todo = await db
        .select()
        .from(places)
        .where(
          and(
            eq(places.projectId, projectId),
            isNull(places.analyzedAt),
            isNotNull(places.website),
          ),
        )
        .limit(Math.min(limit, 50));
      let instagram = 0;
      for (const p of todo) {
        let ig: string | null = null;
        let emails: string[] | null = null;
        try {
          const host = parseAccountUrl(p.website as string)?.handle;
          const fromWebsite = p.website ? parseAccountUrl(p.website) : null;
          // Some businesses list their Instagram page as the "website".
          if (fromWebsite?.platform === "instagram") ig = fromWebsite.handle;
          else if (host) {
            const r = await reader.getAccount(host);
            const igLink = (r.links ?? [])
              .map((l) => parseAccountUrl(l))
              .find((a) => a?.platform === "instagram");
            ig = igLink?.handle ?? null;
            const e = r.stats?.emails;
            emails = Array.isArray(e) && e.length ? (e as string[]).slice(0, 5) : null;
          }
        } catch {
          // An unreadable site is marked analysed so it is not retried every day.
        }
        if (ig) instagram++;
        await db
          .update(places)
          .set({ instagram: ig, emails, analyzedAt: new Date() })
          .where(eq(places.id, p.id));
      }
      return { analyzed: todo.length, instagram };
    },

    /**
     * Starts a job for the Instagram accounts of the project's businesses that
     * were not sent yet: they become ordinary leads (contacts, score, revenue).
     */
    async placesToLeads(projectId: string) {
      const rows = await db
        .select({ id: places.id, instagram: places.instagram, query: places.query })
        .from(places)
        .where(
          and(eq(places.projectId, projectId), isNotNull(places.instagram), isNull(places.sentAt)),
        );
      if (rows.length === 0) return { sent: 0, jobId: null as string | null };
      const names = [...new Set(rows.map((r) => r.instagram as string))].slice(0, ctx.maxJobLimit);
      const { job } = await self().startJob({
        projectId,
        source: { type: "upload", usernames: names, url: `خرائط جوجل: ${rows[0]?.query ?? ""}` },
        limit: names.length,
      });
      await db
        .update(places)
        .set({ sentAt: new Date() })
        .where(
          inArray(
            places.id,
            rows.map((r) => r.id),
          ),
        );
      return { sent: names.length, jobId: job.id };
    },

    /**
     * Reads an account on another platform without saving anything (e.g. a
     * link sent to the Telegram bot). Paid connectors are skipped unless asked.
     */
    async peekAccount(url: string, opts: { allowPaid?: boolean } = {}) {
      const ref = parseAccountUrl(url);
      if (!ref) return null;
      const connector = connectors.get(ref.platform);
      if (!connector || (connector.paid && !opts.allowPaid)) return { ref, account: null };
      try {
        return { ref, account: await connector.getAccount(ref.handle) };
      } catch (err) {
        return { ref, account: null, error: (err as Error).message };
      }
    },

    async addSiteWatch(input: { url: string; label?: string | null }) {
      const url = /^https?:\/\//i.test(input.url.trim())
        ? input.url.trim()
        : `https://${input.url.trim()}`;
      new URL(url);
      const [w] = await db
        .insert(siteWatches)
        .values({ url, label: input.label?.trim() || null })
        .onConflictDoUpdate({
          target: siteWatches.url,
          set: { enabled: true, label: input.label?.trim() || null },
        })
        .returning();
      return w;
    },

    async listSiteWatches() {
      return db.select().from(siteWatches).orderBy(desc(siteWatches.createdAt));
    },

    async removeSiteWatch(id: string) {
      await db.delete(siteWatches).where(eq(siteWatches.id, id));
    },

    /**
     * Reads each watched page (at most once every `everyHours`) and, when its
     * text changed, records the added and removed lines and alerts the owner.
     * The first reading only sets the baseline.
     */
    async checkSiteWatches(now = new Date(), everyHours = 20) {
      if (!deps.readPage) return { checked: 0, changed: 0 };
      const due = await db
        .select()
        .from(siteWatches)
        .where(
          and(
            eq(siteWatches.enabled, true),
            or(
              isNull(siteWatches.lastCheckedAt),
              lt(siteWatches.lastCheckedAt, new Date(now.getTime() - everyHours * 3_600_000)),
            ),
          ),
        )
        .limit(30);
      let changed = 0;
      const alerts: string[] = [];
      for (const w of due) {
        try {
          const page = await deps.readPage(w.url);
          const text = normalizePageText(page.text).slice(0, 30_000);
          const hash = createHash("sha256").update(text).digest("hex");
          if (w.lastHash && w.lastHash !== hash) {
            const diff = pageDiff(w.lastText ?? "", text);
            if (diff.added.length + diff.removed.length > 0) {
              changed++;
              await db
                .update(siteWatches)
                .set({
                  lastDiff: { added: diff.added.slice(0, 40), removed: diff.removed.slice(0, 40) },
                  lastChangedAt: now,
                })
                .where(eq(siteWatches.id, w.id));
              alerts.push(
                [
                  `<${w.label ?? page.title ?? w.url}>`,
                  ...diff.added.slice(0, 5).map((l) => `+ ${l.slice(0, 140)}`),
                  ...diff.removed.slice(0, 3).map((l) => `− ${l.slice(0, 140)}`),
                ].join("\n"),
              );
            }
          }
          await db
            .update(siteWatches)
            .set({ lastHash: hash, lastText: text, lastCheckedAt: now, error: null })
            .where(eq(siteWatches.id, w.id));
        } catch (err) {
          await db
            .update(siteWatches)
            .set({ lastCheckedAt: now, error: (err as Error).message.slice(0, 300) })
            .where(eq(siteWatches.id, w.id));
        }
      }
      if (alerts.length > 0)
        await notify({
          type: "system",
          level: "warn",
          title: `تغيّر ${alerts.length} من مواقع المنافسين`,
          body: alerts.join("\n\n").slice(0, 1500),
          url: "/competitors",
          key: `site-change:${now.toISOString().slice(0, 13)}`,
        });
      return { checked: due.length, changed };
    },

    /** Platforms this server can read (an official connector is configured). */
    connectedPlatforms(): string[] {
      return [...connectors.keys()];
    },
  };
}
