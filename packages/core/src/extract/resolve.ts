import type { RawProfile } from "../types.js";
import { type ExtractedContact, extractContact, isContactEligible } from "./index.js";
import { fetchLinkPage, isLinkPage, type LinkPageContacts } from "./linkpages.js";
import type { EmailDomainStatus } from "./mx.js";
import { findPhones } from "./phones.js";

export interface ResolveDeps {
  /** Reads a link-in-bio page; omit to skip this step. */
  linkPage?: (url: string) => Promise<LinkPageContacts | null>;
  /** Checks an email domain; omit to skip. */
  checkEmail?: (email: string) => Promise<EmailDomainStatus>;
}

export interface ResolvedContact extends ExtractedContact {
  /** The email was dropped because its domain cannot receive mail. */
  emailRejected?: string;
}

/**
 * extractContact, plus the two steps that need the network: reading a
 * link-in-bio page when nothing else was found, and dropping emails whose
 * domain has no mail server.
 */
export async function resolveContact(
  profile: RawProfile,
  deps: ResolveDeps = {},
): Promise<ResolvedContact> {
  let c: ResolvedContact = extractContact(profile);
  const nothing = !c.email && !c.phoneE164 && !c.phoneRaw;

  if (nothing && deps.linkPage && isContactEligible(profile) && isLinkPage(profile.externalUrl)) {
    const page = await deps.linkPage(profile.externalUrl as string).catch(() => null);
    const phone = page?.phoneText ? findPhones(page.phoneText, c.countries)[0] : undefined;
    if (page && (page.emails[0] || phone)) {
      c = {
        ...c,
        email: page.emails[0] ?? null,
        phoneE164: phone?.e164 ?? null,
        phoneRaw: phone?.e164 ? null : (phone?.raw ?? null),
        phoneCountry: phone?.country ?? null,
        contactSource: "link",
      };
    }
  }

  if (c.email && deps.checkEmail && (await deps.checkEmail(c.email)) === "invalid") {
    const rejected = c.email;
    c = { ...c, email: null, emailRejected: rejected };
    if (!c.phoneE164 && !c.phoneRaw) c.contactSource = null;
  }
  return c;
}

export { fetchLinkPage };
