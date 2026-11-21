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

  async sendText(html: string): Promise<void> {
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
  }

  async send(n: NotificationInput & { link?: string }): Promise<void> {
    const lines = [`${ICON[n.level]} <b>${escapeHtml(n.title)}</b>`];
    if (n.body) lines.push(escapeHtml(n.body));
    if (n.link) lines.push(`<a href="${escapeHtml(n.link)}">فتح في اللوحة</a>`);
    await this.sendText(lines.join("\n"));
  }
}
