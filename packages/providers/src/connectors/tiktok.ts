import type { Connector, RemoteAccount } from "@scrapers/core";
import type { ApifyProvider } from "../apify.js";

/**
 * TikTok accounts through Apify (TikTok's own research API is for academics).
 * Each read costs about half a cent of Apify credit, so it is paid: read only
 * when the owner asks, never by the daily task.
 */
export class TikTokConnector implements Connector {
  readonly platform = "tiktok";
  readonly paid = true;
  constructor(private readonly apify: Pick<ApifyProvider, "tiktokProfile">) {}

  getAccount(handle: string): Promise<RemoteAccount> {
    return this.apify.tiktokProfile(handle);
  }
}
