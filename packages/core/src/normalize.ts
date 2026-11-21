/** Converts Arabic-Indic (U+0660–0669) and Persian (U+06F0–06F9) digits to ASCII. */
export function toLatinDigits(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

/**
 * Normalises a bio for extraction: Latin digits, common email obfuscations
 * ("name [at] site [dot] com", "name(at)site.com", "name @ site . com"),
 * and invisible characters removed.
 */
export function normalizeBio(text: string): string {
  let s = toLatinDigits(text.normalize("NFKC"));
  // Zero-width and bidi control characters often pasted into bios.
  s = s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, "");
  s = s.replace(/\s*[[({]\s*(?:at|AT|@)\s*[\])}]\s*/g, "@");
  s = s.replace(/\s*[[({]\s*(?:dot|DOT|\.)\s*[\])}]\s*/g, ".");
  // "name at gmail dot com": only when it clearly forms an address.
  s = s.replace(
    /\b([\w.+-]+)\s+(?:at|AT)\s+([\w-]+(?:\s+(?:dot|DOT)\s+[\w-]+)+)\b/g,
    (_m, user: string, rest: string) => `${user}@${rest.replace(/\s+(?:dot|DOT)\s+/g, ".")}`,
  );
  s = s.replace(/([\w.+-])\s+@\s+([\w-])/g, "$1@$2");
  return s;
}

export function normalizeUsername(input: string): string {
  return input.trim().replace(/^@/, "").toLowerCase();
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}
