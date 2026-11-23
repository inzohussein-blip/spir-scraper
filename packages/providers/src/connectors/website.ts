import type { Connector, RemoteAccount } from "@scrapers/core";
import { analyzeSite, type WebReadOptions } from "../web/site.js";

/**
 * A person's website as an account: title, description, contacts, social
 * accounts, regulators mentioned and whether it runs a partner program.
 * Reads at most four pages and honors robots.txt.
 */
export class WebsiteConnector implements Connector {
  readonly platform = "website";
  constructor(private readonly opts: WebReadOptions = {}) {}

  async getAccount(host: string): Promise<RemoteAccount> {
    const s = await analyzeSite(host, this.opts);
    return {
      displayName: s.title,
      bio: s.description,
      followers: null,
      stats: {
        emails: s.emails,
        phones: s.phones,
        regulators: s.regulators,
        partnerProgram: s.partnerProgram,
        lang: s.lang,
        pages: s.pages.length,
      },
      links: s.accounts.map((a) => a.url),
    };
  }
}
