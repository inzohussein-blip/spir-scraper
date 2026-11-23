import type { NotificationInput, NotificationSink } from "@scrapers/core";

const ICON = { info: "ℹ️", ok: "✅", warn: "⚠️", bad: "⛔" } as const;

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Sends messages to the owner's Telegram chat through a bot (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). */
export class TelegramNotifier implements NotificationSink {
  private readonly fetch: FetchLike;
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    fetchImpl?: FetchLike,
  ) {
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  async sendText(html: string, buttons?: { text: string; data: string }[]): Promise<void> {
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(buttons?.length
          ? {
              reply_markup: {
                inline_keyboard: buttons.map((b) => [
                  { text: b.text, callback_data: b.data.slice(0, 64) },
                ]),
              },
            }
          : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
  }

  /** Acknowledges a button press so Telegram stops its loading spinner. */
  async answerCallback(id: string, text?: string): Promise<void> {
    await this.fetch(`https://api.telegram.org/bot${this.token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, ...(text ? { text } : {}) }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  /** Sends a file to the owner's chat (bots may send up to 50 MB). */
  async sendDocument(name: string, data: Uint8Array, caption?: string): Promise<void> {
    const form = new FormData();
    form.set("chat_id", this.chatId);
    if (caption) form.set("caption", caption.slice(0, 1000));
    form.set("document", new Blob([new Uint8Array(data)]), name);
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Telegram sendDocument failed: HTTP ${res.status}`);
  }

  /** Points the bot's updates at our webhook; Telegram echoes `secret` in a header. */
  async setWebhook(url: string, secret: string): Promise<void> {
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        secret_token: secret,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Telegram setWebhook failed: HTTP ${res.status}`);
  }

  get chat(): string {
    return this.chatId;
  }

  async send(n: NotificationInput & { link?: string }): Promise<void> {
    const lines = [`${ICON[n.level]} <b>${escapeHtml(n.title)}</b>`];
    if (n.body) lines.push(escapeHtml(n.body));
    if (n.link) lines.push(`<a href="${escapeHtml(n.link)}">فتح في اللوحة</a>`);
    await this.sendText(lines.join("\n"));
  }
}
