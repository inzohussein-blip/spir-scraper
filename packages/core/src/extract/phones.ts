import {
  type CountryCode,
  findPhoneNumbersInText,
  parsePhoneNumberFromString,
} from "libphonenumber-js/max";

export interface PhoneMatch {
  /** E.164, present only when the number is valid for a known country. */
  e164?: string;
  country?: CountryCode;
  /** The number as written, when its country could not be confirmed. */
  raw?: string;
}

/** Rewrites the "00" international prefix to "+" so it parses without a country. */
function plusPrefix(text: string): string {
  return text.replace(/(^|[^\d+])00(?=[1-9][\d\s-]{6,})/g, "$1+");
}

/** wa.me/<number>, api.whatsapp.com/send?phone=<number> and tel: links. */
export function phonesFromLinks(text: string): string[] {
  const out: string[] = [];
  const re = /(?:wa\.me\/|whatsapp\.com\/send\/?\?phone=|tel:)\+?([\d\s-]{7,20})/gi;
  for (const m of text.matchAll(re)) {
    const digits = (m[1] ?? "").replace(/\D/g, "");
    if (digits.length >= 7) out.push(`+${digits}`);
  }
  return out;
}

function valid(text: string, defaultCountry?: CountryCode): PhoneMatch[] {
  const opts = defaultCountry ? { defaultCountry, extract: true } : { extract: true };
  return findPhoneNumbersInText(text, opts)
    .map((f) => f.number)
    .filter((n) => n.isValid())
    .map((n) => ({ e164: n.number, ...(n.country ? { country: n.country } : {}) }));
}

/** Digit runs that look like phone numbers (8–15 digits, with spaces, dashes or dots). */
const RAW_RE = /(?<![\d])(?:\+?\d[\d\s.-]{6,18}\d)(?![\d])/g;

function rawCandidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(RAW_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) out.push(m[0].trim());
  }
  return out;
}

/**
 * Finds phone numbers in normalised text, for any country.
 *
 * 1. Numbers written internationally (+ or 00) and WhatsApp/tel links parse as-is.
 * 2. Local numbers are tried against each hinted country in order; a number
 *    counts only if it is valid for that country.
 * 3. Anything left that looks like a phone number is returned raw (unconfirmed).
 */
export function findPhones(text: string, countryHints: readonly CountryCode[] = []): PhoneMatch[] {
  const prepared = plusPrefix(text);
  const byE164 = new Map<string, PhoneMatch>();
  const add = (m: PhoneMatch) => {
    if (m.e164 && !byE164.has(m.e164)) byE164.set(m.e164, m);
  };

  for (const link of phonesFromLinks(prepared)) {
    const n = parsePhoneNumberFromString(link);
    if (n?.isValid()) add({ e164: n.number, ...(n.country ? { country: n.country } : {}) });
  }
  for (const m of valid(prepared)) add(m);
  for (const country of countryHints) {
    for (const m of valid(prepared, country)) add(m);
  }

  const confirmed = [...byE164.values()];
  if (confirmed.length > 0) return confirmed;

  // Nothing confirmed: keep the first plausible number as written.
  const raw = rawCandidates(prepared)[0];
  return raw ? [{ raw }] : [];
}

/** Parses a contact-button phone, which usually comes with its calling code. */
export function parseButtonPhone(
  phone: string,
  callingCode?: string | null,
  countryHints: readonly CountryCode[] = [],
): PhoneMatch | undefined {
  const digits = phone.replace(/[^\d+]/g, "");
  if (!digits) return undefined;
  const attempts: string[] = [];
  if (digits.startsWith("+")) attempts.push(digits);
  if (callingCode) {
    const local = digits
      .replace(/^\+/, "")
      .replace(new RegExp(`^${callingCode}`), "")
      .replace(/^0+/, "");
    attempts.push(`+${callingCode}${local}`);
  }
  for (const a of attempts) {
    const n = parsePhoneNumberFromString(a);
    if (n?.isValid()) return { e164: n.number, ...(n.country ? { country: n.country } : {}) };
  }
  for (const country of countryHints) {
    const n = parsePhoneNumberFromString(digits, country);
    if (n?.isValid()) return { e164: n.number, country };
  }
  return { raw: phone.trim() };
}
