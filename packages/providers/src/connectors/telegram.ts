import { AccountNotFoundError, type Connector, type RemoteAccount } from "@scrapers/core";
import type { FetchLike } from "../http.js";

/**
 * Public Telegram channels and groups through the official Bot API (the same
 * TELEGRAM_BOT_TOKEN used for notifications): getChat for the title and
 * description, getChatMemberCount for the size. Private chats are not readable.
 */
export class TelegramConnector implements Connector {
  readonly platform = "telegram";
  private readonly fetch: FetchLike;
  constructor(
    private readonly token: string,
    fetchImpl?: FetchLike,
    private readonly base = "https://api.telegram.org",
  ) {
    this.fetch = fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  }

  private async call<T>(method: string, chat: string): Promise<T> {
    const res = await this.fetch(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: `@${chat.replace(/^@/, "")}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (body.ok && body.result !== undefined) return body.result;
    // Telegram answers 400 "chat not found" for unknown and private chats.
    if (res.status === 400 || res.status === 404)
      throw new AccountNotFoundError(`Telegram @${chat}: ${body.description ?? "not found"}`);
    throw new Error(`Telegram ${method}: HTTP ${res.status} ${body.description ?? ""}`.trim());
  }

  async getAccount(handle: string): Promise<RemoteAccount> {
    const chat = await this.call<{ title?: string; description?: string; type?: string }>(
      "getChat",
      handle,
    );
    const members = await this.call<number>("getChatMemberCount", handle).catch(() => null);
    return {
      displayName: chat.title ?? null,
      bio: chat.description ?? null,
      followers: typeof members === "number" ? members : null,
      stats: { type: chat.type ?? null },
    };
  }
}
