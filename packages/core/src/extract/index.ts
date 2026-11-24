import type { CountryCode } from "libphonenumber-js/max";
import { normalizeBio } from "../normalize.js";
import type { RawProfile } from "../types.js";
import { inferCountries } from "./country.js";
import { findEmails, isPlausibleEmail } from "./emails.js";
import { contactsFromUrl } from "./links.js";
import { findPhones, type PhoneMatch, parseButtonPhone } from "./phones.js";

export * from "./accounts.js";
export * from "./competitor.js";
export * from "./country.js";
export * from "./emails.js";
export * from "./intent.js";
export * from "./language.js";
export * from "./linkpages.js";
export * from "./links.js";
export * from "./mentions.js";
export * from "./mx.js";
export * from "./pagediff.js";
export * from "./phones.js";
export * from "./quality.js";
export * from "./resolve.js";

export type ContactSource = "business_button" | "bio" | "link";

export interface ExtractedContact {
  email: string | null;
  phoneE164: string | null;
  phoneRaw: string | null;
  phoneCountry: string | null;
  contactSource: ContactSource | null;
  /** Countries inferred from the profile, most likely first. */
  countries: CountryCode[];
}

export const INFLUENCER_FOLLOWERS = 10_000;

/**
 * Only business accounts, verified accounts and influencers keep contact
 * details. Personal accounts are stored for classification only.
 */
export function isContactEligible(
  p: Pick<RawProfile, "isBusiness" | "isVerified" | "followers">,
): boolean {
  return p.isBusiness || p.isVerified || (p.followers ?? 0) >= INFLUENCER_FOLLOWERS;
}

const EMPTY: Omit<ExtractedContact, "countries"> = {
  email: null,
  phoneE164: null,
  phoneRaw: null,
  phoneCountry: null,
  contactSource: null,
};

function phoneFields(m: PhoneMatch | undefined) {
  return {
    phoneE164: m?.e164 ?? null,
    phoneRaw: m?.e164 ? null : (m?.raw ?? null),
    phoneCountry: m?.country ?? null,
  };
}

/** Extracts the best public contact for a profile, following docs/PLAN.md §7. */
export function extractContact(profile: RawProfile): ExtractedContact {
  const bio = normalizeBio(profile.bio ?? "");
  const bioEmails = findEmails(bio);
  const link = contactsFromUrl(profile.externalUrl);
  const buttonEmail =
    profile.businessEmail && isPlausibleEmail(profile.businessEmail)
      ? profile.businessEmail.trim().toLowerCase()
      : null;
  const countries = inferCountries({
    bio: [bio, profile.city].filter(Boolean).join("\n"),
    fullName: profile.fullName,
    emails: [buttonEmail, ...bioEmails, ...link.emails].filter((e): e is string => !!e),
  });

  if (!isContactEligible(profile)) return { ...EMPTY, countries };

  // 1. Public contact button (phone, or the WhatsApp option).
  const buttonNumber = profile.businessPhone ?? profile.businessWhatsapp;
  const buttonPhone = buttonNumber
    ? parseButtonPhone(buttonNumber, profile.businessPhoneCountryCode, countries)
    : undefined;
  if (buttonEmail || buttonPhone) {
    return {
      email: buttonEmail ?? bioEmails[0] ?? null,
      ...phoneFields(buttonPhone ?? findPhones(bio, countries)[0]),
      contactSource: "business_button",
      countries,
    };
  }

  // 2. Bio text.
  const bioPhone = findPhones(bio, countries)[0];
  if (bioEmails[0] || bioPhone) {
    return {
      email: bioEmails[0] ?? null,
      ...phoneFields(bioPhone),
      contactSource: "bio",
      countries,
    };
  }

  // 3. Bio link (mailto:, tel:, WhatsApp).
  const linkPhone = link.text ? findPhones(link.text, countries)[0] : undefined;
  if (link.emails[0] || linkPhone) {
    return {
      email: link.emails[0] ?? null,
      ...phoneFields(linkPhone),
      contactSource: "link",
      countries,
    };
  }

  return { ...EMPTY, countries };
}
