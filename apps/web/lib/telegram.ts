import "server-only";
import { createHash } from "node:crypto";

/** Secret Telegram echoes on every webhook call, derived from AUTH_SECRET (no extra variable). */
export function telegramWebhookSecret(): string {
  return createHash("sha256")
    .update(`telegram-webhook:${process.env.AUTH_SECRET ?? ""}`)
    .digest("hex")
    .slice(0, 48);
}
