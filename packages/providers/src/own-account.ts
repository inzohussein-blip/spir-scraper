import type { OwnAccount, OwnComment, OwnMedia } from "@scrapers/core";
import type { FetchLike } from "./http.js";

/**
 * The owner's own business/creator account through the Instagram Graph API
 * (IG_BUSINESS_ACCOUNT_ID + IG_GRAPH_TOKEN): their posts, the comments on
 * them, and replies to people who messaged them (within Meta's 24-hour window).
 */
export class GraphOwnAccount implements OwnAccount {
  private readonly fetch: FetchLike;
  private readonly base: string;
  constructor(
    private readonly igUserId: string,
    private readonly token: string,
    opts: { version?: string; fetch?: FetchLike } = {},
  ) {
    this.fetch = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
    this.base = `https://graph.facebook.com/${opts.version ?? "v23.0"}`;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", this.token);
    const res = await this.fetch(url.toString(), { signal: AbortSignal.timeout(20_000) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok || body.error)
      throw new Error(`Graph API: ${body.error?.message ?? `HTTP ${res.status}`}`);
    return body;
  }

  async listMedia(limit: number): Promise<OwnMedia[]> {
    const r = await this.get<{
      data?: {
        id: string;
        caption?: string;
        permalink?: string;
        media_type?: string;
        timestamp?: string;
        like_count?: number;
        comments_count?: number;
      }[];
    }>(`${this.igUserId}/media`, {
      fields: "id,caption,permalink,media_type,timestamp,like_count,comments_count",
      limit: String(Math.min(limit, 50)),
    });
    return (r.data ?? []).map((m) => ({
      id: m.id,
      caption: m.caption ?? null,
      permalink: m.permalink ?? null,
      type: m.media_type?.toLowerCase() ?? null,
      timestamp: m.timestamp ?? null,
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null,
    }));
  }

  async listComments(mediaId: string, limit: number): Promise<OwnComment[]> {
    const r = await this.get<{
      data?: { id: string; text?: string; username?: string; timestamp?: string }[];
    }>(`${mediaId}/comments`, {
      fields: "id,text,username,timestamp",
      limit: String(Math.min(limit, 100)),
    });
    return (r.data ?? []).map((c) => ({
      id: c.id,
      text: c.text ?? "",
      username: c.username?.toLowerCase() ?? null,
      timestamp: c.timestamp ?? null,
    }));
  }

  async sendMessage(recipientId: string, text: string): Promise<{ id: string }> {
    const res = await this.fetch(
      `${this.base}/${this.igUserId}/messages?access_token=${encodeURIComponent(this.token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      message_id?: string;
      error?: { message?: string };
    };
    if (!res.ok || body.error || !body.message_id)
      throw new Error(`Graph API: ${body.error?.message ?? `HTTP ${res.status}`}`);
    return { id: body.message_id };
  }
}
