// Minimal types for web-push 4 (ESM, ships no type definitions).
declare module "web-push" {
  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  export class WebPushError extends Error {
    statusCode: number;
  }
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer | null,
    options?: { TTL?: number; urgency?: "very-low" | "low" | "normal" | "high" },
  ): Promise<{ statusCode: number }>;
}
