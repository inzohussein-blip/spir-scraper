import { toolItems, toolRuns } from "@scrapers/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { commentIntent } from "../../extract/index.js";
import { adLibraryUrl, storeTool, tiktokVideoUrl, youtubeVideoId } from "../../store.js";
import type { Core } from "../core.js";
import type { CoreSelf } from "./context.js";

/** Apify Actors the store's tool runs use. */
export const TOOL_ACTORS = {
  "fb-ads": "curious_coder~facebook-ads-library-scraper",
  "tiktok-comments": "clockworks~tiktok-comments-scraper",
} as const;

/** The most results one tool run keeps. */
export const TOOL_MAX_ITEMS = 1000;

export type ToolRunInput = {
  tool: string;
  /** A link (video, Facebook page) or keywords, per tool. */
  query: string;
  /** fb-ads: a 2-letter country code or ALL. */
  country?: string;
  limit?: number;
  projectId?: string | null;
};

type Item = Record<string, unknown>;
type Result = { key: string; data: Item; flagged: boolean };

const pick = (o: Item | undefined, ...keys: string[]): unknown => {
  for (const k of keys) {
    let v: unknown = o;
    for (const part of k.split(".")) v = (v as Item | undefined)?.[part];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const isoDate = (v: unknown) => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

/** A comment as every comment tool stores it, flagged when it shows buying intent. */
function comment(o: {
  key: string;
  author: string | null;
  authorUrl: string | null;
  text: string;
  likes: number;
  at: string | null;
  url: string | null;
}): Result {
  const intent = commentIntent(o.text);
  return {
    key: o.key,
    flagged: intent.length > 0,
    data: {
      author: o.author,
      authorUrl: o.authorUrl,
      text: o.text.slice(0, 2000),
      likes: o.likes,
      at: o.at,
      url: o.url,
      intent,
    },
  };
}

/** One Meta Ad Library item in a stable shape. */
export function mapAd(o: Item): Result | null {
  const id = str(pick(o, "ad_archive_id", "adArchiveID", "adArchiveId", "ad_id", "id"));
  if (!id) return null;
  const pageId = str(pick(o, "page_id", "pageId", "snapshot.page_id"));
  const text = str(pick(o, "snapshot.body.text", "snapshot.body.markup.__html", "body", "text"));
  const platforms = pick(o, "publisher_platform", "publisherPlatform", "platforms");
  return {
    key: id,
    flagged: pick(o, "is_active", "isActive") === true,
    data: {
      page: str(pick(o, "page_name", "pageName", "snapshot.page_name")),
      pageUrl:
        str(pick(o, "snapshot.page_profile_uri", "page_profile_uri", "pageUrl")) ??
        (pageId ? `https://www.facebook.com/${pageId}` : null),
      text: text?.slice(0, 2000) ?? null,
      title: str(pick(o, "snapshot.title", "title")),
      link: str(pick(o, "snapshot.link_url", "link_url", "linkUrl")),
      startedAt: isoDate(pick(o, "start_date", "startDate", "start_date_string")),
      active: pick(o, "is_active", "isActive") === true,
      platforms: Array.isArray(platforms) ? platforms.map(String) : [],
      url: `https://www.facebook.com/ads/library/?id=${id}`,
    },
  };
}

/** One TikTok comment from the Apify Actor. */
export function mapTikTokComment(o: Item): Result | null {
  const id = str(pick(o, "cid", "id"));
  const text = str(pick(o, "text"));
  if (!id || !text) return null;
  const user = str(pick(o, "uniqueId", "user.uniqueId"));
  return comment({
    key: id,
    author: user,
    authorUrl: user ? `https://www.tiktok.com/@${user}` : null,
    text,
    likes: num(pick(o, "diggCount", "likes")),
    at: isoDate(pick(o, "createTimeISO", "createTime")),
    url: str(pick(o, "videoWebUrl")),
  });
}

/**
 * Tools from the «المتجر» window whose results are a dataset rather than
 * leads: competitors' ads, and comments under YouTube and TikTok videos with
 * the ones asking how to join flagged. Nothing is sent to anyone.
 */
export function toolsMethods(core: Core, _api: () => CoreSelf) {
  const { db, deps } = core;
  const tools = deps.tools ?? {};

  /** Fetches a tool's results; the cost is an estimate from the Store price. */
  async function fetchResults(input: ToolRunInput, limit: number): Promise<Result[]> {
    switch (input.tool) {
      case "youtube-comments": {
        if (!tools.youtubeComments) throw new Error("تعليقات يوتيوب تحتاج YOUTUBE_API_KEY");
        const id = youtubeVideoId(input.query);
        if (!id) throw new Error("ضع رابط فيديو يوتيوب صحيحاً.");
        const list = await tools.youtubeComments(id, limit);
        return list.map((c) =>
          comment({
            key: c.id,
            author: c.author,
            authorUrl: c.authorUrl,
            text: c.text,
            likes: c.likes,
            at: c.at,
            url: `https://www.youtube.com/watch?v=${id}&lc=${c.id}`,
          }),
        );
      }
      case "tiktok-comments": {
        if (!tools.apifyActor) throw new Error("تعليقات تيك توك تحتاج APIFY_TOKEN");
        const url = tiktokVideoUrl(input.query);
        if (!url) throw new Error("ضع رابط فيديو تيك توك صحيحاً.");
        const items = await tools.apifyActor(
          TOOL_ACTORS["tiktok-comments"],
          { postURLs: [url], commentsPerPost: limit, maxRepliesPerComment: 0 },
          limit,
        );
        return items.map(mapTikTokComment).filter((r): r is Result => !!r);
      }
      case "fb-ads": {
        if (!tools.apifyActor) throw new Error("مكتبة الإعلانات تحتاج APIFY_TOKEN");
        if (!input.query.trim()) throw new Error("اكتب كلمات البحث أو رابط صفحة فيسبوك.");
        const country = input.country ?? "ALL";
        const items = await tools.apifyActor(
          TOOL_ACTORS["fb-ads"],
          {
            urls: [{ url: adLibraryUrl(input.query, country) }],
            count: limit,
            "scrapePageAds.activeStatus": "active",
            "scrapePageAds.countryCode": /^[A-Za-z]{2}$/.test(country)
              ? country.toUpperCase()
              : "ALL",
          },
          limit,
        );
        return items.map(mapAd).filter((r): r is Result => !!r);
      }
      default:
        throw new Error("هذه الأداة لا تعمل بهذه الطريقة.");
    }
  }

  return {
    /** Whether each tool run's service is set up. */
    toolAvailability() {
      return {
        "youtube-comments": !!tools.youtubeComments,
        "tiktok-comments": !!tools.apifyActor,
        "fb-ads": !!tools.apifyActor,
      } as Record<string, boolean>;
    },

    /**
     * Runs a store tool and keeps its results as the run's dataset. Waits for
     * the results (an Apify run takes up to a few minutes); a failure is kept
     * on the run with its reason.
     */
    async runTool(input: ToolRunInput) {
      const tool = storeTool(input.tool);
      if (tool?.run.kind !== "tool") throw new Error("أداة غير معروفة.");
      const limit = Math.min(Math.max(1, Math.round(input.limit ?? 100)), TOOL_MAX_ITEMS);
      const [run] = await db
        .insert(toolRuns)
        .values({
          tool: tool.id,
          projectId: input.projectId ?? null,
          input: {
            query: input.query.trim(),
            ...(input.country ? { country: input.country } : {}),
            limit,
          },
        })
        .returning();
      if (!run) throw new Error("tool run insert returned nothing");
      try {
        const results = (await fetchResults(input, limit)).slice(0, limit);
        // The first copy of a result wins (later ones are repeats of the same comment or ad).
        const seen = new Set<string>();
        const unique = results.filter((r) => !seen.has(r.key) && !!seen.add(r.key));
        for (let i = 0; i < unique.length; i += 200) {
          await db
            .insert(toolItems)
            .values(
              unique
                .slice(i, i + 200)
                .map((r) => ({ runId: run.id, key: r.key, data: r.data, flagged: r.flagged })),
            )
            .onConflictDoNothing();
        }
        const flagged = unique.filter((r) => r.flagged).length;
        const cost =
          tool.pricing.kind === "apify" && tool.pricing.per1k
            ? (unique.length / 1000) * tool.pricing.per1k
            : 0;
        const [done] = await db
          .update(toolRuns)
          .set({
            status: "done",
            items: unique.length,
            flagged,
            costUsd: cost.toFixed(4),
            finishedAt: new Date(),
          })
          .where(eq(toolRuns.id, run.id))
          .returning();
        return done ?? run;
      } catch (e) {
        const [failed] = await db
          .update(toolRuns)
          .set({
            status: "failed",
            error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
            finishedAt: new Date(),
          })
          .where(eq(toolRuns.id, run.id))
          .returning();
        return failed ?? run;
      }
    },

    /** Latest tool runs, newest first (optionally of one tool). */
    async listToolRuns(opts: { tool?: string; limit?: number } = {}) {
      return db
        .select()
        .from(toolRuns)
        .where(opts.tool ? eq(toolRuns.tool, opts.tool) : undefined)
        .orderBy(desc(toolRuns.startedAt))
        .limit(Math.min(opts.limit ?? 50, 200));
    },

    async getToolRun(id: string) {
      const [run] = await db.select().from(toolRuns).where(eq(toolRuns.id, id));
      return run ?? null;
    },

    /** A run's dataset: flagged results first, then by order found. */
    async toolRunItems(runId: string, opts: { flaggedOnly?: boolean; limit?: number } = {}) {
      return db
        .select()
        .from(toolItems)
        .where(
          and(
            eq(toolItems.runId, runId),
            opts.flaggedOnly ? eq(toolItems.flagged, true) : undefined,
          ),
        )
        .orderBy(desc(toolItems.flagged), toolItems.createdAt, sql`${toolItems.key}`)
        .limit(Math.min(opts.limit ?? TOOL_MAX_ITEMS, 5000));
    },

    async deleteToolRun(id: string) {
      await db.delete(toolRuns).where(eq(toolRuns.id, id));
    },
  };
}
