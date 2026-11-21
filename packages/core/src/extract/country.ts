import { type CountryCode, getCountries } from "libphonenumber-js/max";
import { emailCountryTld } from "./emails.js";

const ALL = new Set<string>(getCountries());

/**
 * ccTLDs used as generic domains; they say nothing about where a person is.
 * (.co Colombia, .io, .me, .tv, .ai, .ly, .fm, .gg, .to, .so, .cc, .ws, .la, .sh, .ac, .vc, .is)
 */
const GENERIC_TLDS = new Set([
  "CO",
  "IO",
  "ME",
  "TV",
  "AI",
  "LY",
  "FM",
  "GG",
  "TO",
  "SO",
  "CC",
  "WS",
  "LA",
  "SH",
  "AC",
  "VC",
  "IS",
  "AM",
  "IM",
]);

/** Common short forms and spellings that Intl.DisplayNames does not produce. */
const ALIASES: Record<string, CountryCode> = {
  uae: "AE",
  emirates: "AE",
  dubai: "AE",
  "abu dhabi": "AE",
  sharjah: "AE",
  الإمارات: "AE",
  الامارات: "AE",
  دبي: "AE",
  أبوظبي: "AE",
  ksa: "SA",
  saudi: "SA",
  riyadh: "SA",
  jeddah: "SA",
  السعودية: "SA",
  الرياض: "SA",
  جدة: "SA",
  الدمام: "SA",
  kuwait: "KW",
  الكويت: "KW",
  qatar: "QA",
  doha: "QA",
  قطر: "QA",
  الدوحة: "QA",
  bahrain: "BH",
  البحرين: "BH",
  muscat: "OM",
  مسقط: "OM",
  iraq: "IQ",
  baghdad: "IQ",
  erbil: "IQ",
  basra: "IQ",
  العراق: "IQ",
  بغداد: "IQ",
  البصرة: "IQ",
  أربيل: "IQ",
  اربيل: "IQ",
  egypt: "EG",
  cairo: "EG",
  مصر: "EG",
  القاهرة: "EG",
  الإسكندرية: "EG",
  amman: "JO",
  عمّان: "JO",
  الأردن: "JO",
  الاردن: "JO",
  beirut: "LB",
  لبنان: "LB",
  بيروت: "LB",
  syria: "SY",
  سوريا: "SY",
  دمشق: "SY",
  palestine: "PS",
  فلسطين: "PS",
  morocco: "MA",
  المغرب: "MA",
  algeria: "DZ",
  الجزائر: "DZ",
  tunisia: "TN",
  تونس: "TN",
  libya: "LY",
  ليبيا: "LY",
  sudan: "SD",
  السودان: "SD",
  yemen: "YE",
  اليمن: "YE",
  turkey: "TR",
  türkiye: "TR",
  istanbul: "TR",
  تركيا: "TR",
  اسطنبول: "TR",
  uk: "GB",
  england: "GB",
  london: "GB",
  بريطانيا: "GB",
  لندن: "GB",
  usa: "US",
  "united states": "US",
  أمريكا: "US",
  امريكا: "US",
  iran: "IR",
  إيران: "IR",
  ايران: "IR",
};

type Matcher = { country: CountryCode; latin: boolean; term: string };

let matchers: Matcher[] | undefined;

/** Builds country-name matchers for every country, in English and Arabic, once. */
function getMatchers(): Matcher[] {
  if (matchers) return matchers;
  const list: Matcher[] = [];
  const en = new Intl.DisplayNames(["en"], { type: "region" });
  const ar = new Intl.DisplayNames(["ar"], { type: "region" });
  for (const code of getCountries()) {
    for (const name of [en.of(code), ar.of(code)]) {
      if (name && name !== code) list.push(toMatcher(code, name));
    }
  }
  for (const [term, code] of Object.entries(ALIASES)) list.push(toMatcher(code, term));
  // Longest first so "South Sudan" wins over "Sudan".
  list.sort((a, b) => b.term.length - a.term.length);
  matchers = list;
  return list;
}

function toMatcher(country: CountryCode, name: string): Matcher {
  const term = name.toLowerCase();
  return { country, term, latin: /^[\p{Script=Latin}\s.'’-]+$/u.test(term) };
}

/** Decodes flag emoji (pairs of regional indicator symbols) to country codes. */
export function flagCountries(text: string): CountryCode[] {
  const out: CountryCode[] = [];
  for (const m of text.matchAll(/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu)) {
    const code = [m[1], m[2]]
      .map((c) => String.fromCharCode((c?.codePointAt(0) ?? 0) - 0x1f1e6 + 65))
      .join("");
    if (ALL.has(code)) out.push(code as CountryCode);
  }
  return out;
}

/** Finds country names (English or Arabic) and common city names in text. */
export function namedCountries(text: string): CountryCode[] {
  const lower = text.toLowerCase();
  const found: CountryCode[] = [];
  let rest = lower;
  for (const m of getMatchers()) {
    const idx = m.latin ? indexOfWord(rest, m.term) : rest.indexOf(m.term);
    if (idx === -1) continue;
    found.push(m.country);
    // Blank out the match so "South Sudan" does not also count as "Sudan".
    rest = rest.slice(0, idx) + " ".repeat(m.term.length) + rest.slice(idx + m.term.length);
  }
  return found;
}

function indexOfWord(haystack: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").exec(haystack);
  return m ? m.index : -1;
}

export interface CountryHints {
  bio?: string | null | undefined;
  fullName?: string | null | undefined;
  emails?: string[] | undefined;
}

/**
 * Infers which countries an account is likely in, most likely first.
 * Used only to interpret local-format phone numbers, and every number is then
 * validated against the country, so a wrong hint costs nothing but a miss.
 */
export function inferCountries(hints: CountryHints): CountryCode[] {
  const text = [hints.fullName, hints.bio].filter(Boolean).join("\n");
  const ordered = [
    ...flagCountries(text),
    ...namedCountries(text),
    ...(hints.emails ?? [])
      .map(emailCountryTld)
      .filter((c): c is string => !!c && ALL.has(c) && !GENERIC_TLDS.has(c)),
  ] as CountryCode[];
  return [...new Set(ordered)];
}
