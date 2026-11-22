import { normalizeEmail } from "../normalize.js";

const EMAIL_RE =
  /[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/gi;

// Things that look like addresses but are not: image names, retina suffixes, placeholders.
const FILE_TLDS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mov"]);
const PLACEHOLDER = /^(?:example|test|email|name|your)@|@(?:example|domain|email)\./;

export function isPlausibleEmail(email: string): boolean {
  const e = normalizeEmail(email);
  const tld = e.split(".").pop() ?? "";
  if (FILE_TLDS.has(tld)) return false;
  if (PLACEHOLDER.test(e)) return false;
  if (e.includes("..")) return false;
  return true;
}

/** Extracts unique, plausible email addresses from already-normalised text. */
export function findEmails(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = normalizeEmail(m[0]);
    if (isPlausibleEmail(e)) out.add(e);
  }
  return [...out];
}

/** Returns the country-code TLD of an email's domain, if it is one, e.g. "SA". */
export function emailCountryTld(email: string): string | undefined {
  const tld = email.split(".").pop()?.toUpperCase();
  return tld && tld.length === 2 ? tld : undefined;
}
