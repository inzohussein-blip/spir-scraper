export type NotificationLevel = "info" | "ok" | "warn" | "bad";
export type NotificationType = "job" | "provider" | "budget" | "ai" | "security" | "system";

export interface NotificationInput {
  type: NotificationType;
  level: NotificationLevel;
  title: string;
  body?: string;
  /** Dashboard path to open, e.g. /jobs/<id>. */
  url?: string;
  /** Same key within 30 minutes is not repeated. Defaults to type + title. */
  key?: string;
}

/** Somewhere notifications go besides the dashboard bell, e.g. Telegram. */
export interface NotificationSink {
  send(n: NotificationInput & { link?: string }): Promise<void>;
}

/** Hides secrets in log lines and error messages before they are stored or sent. */
export function redactSecrets(text: string): string {
  return String(text)
    .replace(/\bsk_[A-Za-z0-9_-]{10,}/g, "sk_<redacted>")
    .replace(/\bapify_api_[A-Za-z0-9]{10,}/g, "apify_api_<redacted>")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-<redacted>")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "<telegram-token>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1<redacted>")
    .replace(/(access_token|token|key|secret|password)=([^&\s]+)/gi, "$1=<redacted>")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://<credentials>@");
}
