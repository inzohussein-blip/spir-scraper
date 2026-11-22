import type { NotificationInput, NotificationSink } from "@scrapers/core";
import * as webpush from "web-push";

export interface PushStore {
  listPushSubscriptions(): Promise<{ endpoint: string; p256dh: string; auth: string }[]>;
  deletePushSubscription(endpoint: string): Promise<void>;
}

export type SendPush = typeof webpush.sendNotification;

/**
 * Browser push (idea from the Spir bot panel): notifications reach the
 * phone or desktop even when the dashboard is closed. Needs VAPID keys
 * (generate once with `scrapers push keys`).
 */
export class WebPushSink implements NotificationSink {
  private readonly push: SendPush;

  constructor(
    private readonly store: () => PushStore,
    vapid: { publicKey: string; privateKey: string; subject: string },
    push?: SendPush,
  ) {
    if (!push) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    this.push = push ?? webpush.sendNotification;
  }

  private async deliver(sub: { endpoint: string; p256dh: string; auth: string }, payload: string) {
    try {
      await this.push(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        {
          TTL: 3600,
        },
      );
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410: the browser dropped the subscription.
      if (status === 404 || status === 410) await this.store().deletePushSubscription(sub.endpoint);
      else throw err;
    }
  }

  async send(n: NotificationInput & { link?: string }): Promise<void> {
    const subs = await this.store().listPushSubscriptions();
    const payload = JSON.stringify({
      title: n.title,
      body: n.body ?? "",
      url: n.url ?? "/",
      level: n.level,
    });
    await Promise.all(subs.map((s) => this.deliver(s, payload)));
  }
}

export const generateVapidKeys = () => webpush.generateVAPIDKeys();
