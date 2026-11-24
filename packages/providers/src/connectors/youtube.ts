import {
  AccountNotFoundError,
  type Connector,
  type RemoteAccount,
  type YouTubeComment,
} from "@scrapers/core";
import type { FetchLike } from "../http.js";

/**
 * YouTube channels through the official YouTube Data API v3 (YOUTUBE_API_KEY,
 * free quota of 10,000 units a day; one channel read costs 1 unit).
 */
export class YouTubeConnector implements Connector {
  readonly platform = "youtube";
  private readonly fetch: FetchLike;
  constructor(
    private readonly apiKey: string,
    fetchImpl?: FetchLike,
    private readonly base = "https://www.googleapis.com/youtube/v3",
  ) {
    this.fetch = fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  }

  async getAccount(handle: string): Promise<RemoteAccount> {
    const qs = new URLSearchParams({ part: "snippet,statistics", key: this.apiKey });
    // Channel ids start with UC; everything else is an @handle.
    if (/^UC[\w-]{20,}$/.test(handle)) qs.set("id", handle);
    else qs.set("forHandle", `@${handle.replace(/^@/, "")}`);
    const res = await this.fetch(`${this.base}/channels?${qs}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`YouTube API: HTTP ${res.status} ${body}`.trim());
    }
    const data = (await res.json()) as {
      items?: {
        id: string;
        snippet?: { title?: string; description?: string; customUrl?: string; country?: string };
        statistics?: {
          subscriberCount?: string;
          videoCount?: string;
          viewCount?: string;
          hiddenSubscriberCount?: boolean;
        };
      }[];
    };
    const ch = data.items?.[0];
    if (!ch) throw new AccountNotFoundError(`YouTube channel @${handle} not found`);
    const n = (v?: string) => (v === undefined ? null : Number(v));
    return {
      displayName: ch.snippet?.title ?? null,
      bio: ch.snippet?.description ?? null,
      followers: ch.statistics?.hiddenSubscriberCount ? null : n(ch.statistics?.subscriberCount),
      stats: {
        channelId: ch.id,
        videos: n(ch.statistics?.videoCount),
        views: n(ch.statistics?.viewCount),
        country: ch.snippet?.country ?? null,
      },
    };
  }

  /**
   * Top-level comments of a video, most relevant first (1 quota unit per 100
   * comments). Videos with comments turned off return an empty list.
   */
  async videoComments(videoId: string, max: number): Promise<YouTubeComment[]> {
    const out: YouTubeComment[] = [];
    let page: string | undefined;
    while (out.length < max) {
      const qs = new URLSearchParams({
        part: "snippet",
        videoId,
        maxResults: String(Math.min(100, max - out.length)),
        order: "relevance",
        textFormat: "plainText",
        key: this.apiKey,
      });
      if (page) qs.set("pageToken", page);
      const res = await this.fetch(`${this.base}/commentThreads?${qs}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 403 && out.length === 0) {
        const body = await res.text().catch(() => "");
        if (body.includes("commentsDisabled")) return [];
        throw new Error(`YouTube API: HTTP 403 ${body.slice(0, 200)}`.trim());
      }
      if (res.status === 404) throw new Error("فيديو يوتيوب غير موجود أو خاص.");
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`YouTube API: HTTP ${res.status} ${body}`.trim());
      }
      const data = (await res.json()) as {
        nextPageToken?: string;
        items?: {
          id: string;
          snippet?: {
            topLevelComment?: {
              id?: string;
              snippet?: {
                authorDisplayName?: string;
                authorChannelUrl?: string;
                textDisplay?: string;
                textOriginal?: string;
                likeCount?: number;
                publishedAt?: string;
              };
            };
          };
        }[];
      };
      for (const t of data.items ?? []) {
        const c = t.snippet?.topLevelComment?.snippet;
        const text = c?.textOriginal ?? c?.textDisplay ?? "";
        if (!text) continue;
        out.push({
          id: t.snippet?.topLevelComment?.id ?? t.id,
          author: c?.authorDisplayName ?? null,
          authorUrl: c?.authorChannelUrl ?? null,
          text,
          likes: c?.likeCount ?? 0,
          at: c?.publishedAt ?? null,
        });
      }
      page = data.nextPageToken;
      if (!page) break;
    }
    return out.slice(0, max);
  }
}
