import { findEmails, findPhones, parseAccountUrl } from "@scrapers/core";
import type { FetchLike } from "../http.js";
import { parseHtml } from "./html.js";
import { type Lookup, robotsAllows, safeFetch, UnsafeUrlError } from "./safe-fetch.js";

export interface WebReadOptions {
  fetch?: FetchLike;
  lookup?: Lookup;
}

export interface PageReading {
  url: string;
  title: string | null;
  description: string | null;
  lang: string | null;
  /** Readable text, cut to `maxChars`. */
  text: string;
  links: { href: string; text: string }[];
  emails: string[];
  phones: string[];
  /** Accounts on social platforms linked from the page. */
  accounts: { platform: string; handle: string; url: string }[];
}

const robotsCache = new Map<string, { at: number; text: string }>();

async function allowedByRobots(u: URL, o: WebReadOptions): Promise<boolean> {
  const key = u.origin;
  const hit = robotsCache.get(key);
  let text = hit && Date.now() - hit.at < 3_600_000 ? hit.text : null;
  if (text === null) {
    try {
      const r = await safeFetch(`${u.origin}/robots.txt`, {
        ...o,
        maxBytes: 200_000,
        timeoutMs: 5_000,
      });
      text = r.status === 200 ? r.body : "";
    } catch {
      text = "";
    }
    robotsCache.set(key, { at: Date.now(), text });
  }
  return robotsAllows(text, u.pathname || "/");
}

/** Reads one public page: text, links, contacts and social accounts. Honors robots.txt. */
export async function readPage(
  rawUrl: string,
  o: WebReadOptions & { maxChars?: number } = {},
): Promise<PageReading> {
  const url = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  const u = new URL(url);
  if (!(await allowedByRobots(u, o)))
    throw new UnsafeUrlError("ملف robots.txt في الموقع يمنع قراءة هذه الصفحة");
  const res = await safeFetch(url, o);
  if (res.status >= 400) throw new Error(`الموقع ردّ بالخطأ ${res.status}`);
  const page = parseHtml(res.body, res.url);
  const mailto = page.links
    .filter((l) => /^mailto:/i.test(l.href))
    .map((l) => l.href.slice(7).split("?")[0] ?? "");
  const tel = page.links.filter((l) => /^tel:/i.test(l.href)).map((l) => l.href.slice(4));
  const accounts = new Map<string, { platform: string; handle: string; url: string }>();
  for (const l of page.links) {
    const a = /^https?:/i.test(l.href) ? parseAccountUrl(l.href) : null;
    if (a && a.platform !== "website") accounts.set(`${a.platform}:${a.handle}`, a);
  }
  const fullText = `${page.text}\n${tel.join("\n")}`;
  return {
    url: res.url,
    title: page.title,
    description: page.description,
    lang: page.lang,
    text: page.text.slice(0, o.maxChars ?? 15_000),
    links: page.links.filter((l) => /^https?:/i.test(l.href)).slice(0, 150),
    emails: [...new Set([...findEmails(page.text), ...findEmails(mailto.join(" "))])].slice(0, 20),
    phones: [
      ...new Set(
        findPhones(fullText)
          .map((p) => p.e164 ?? p.raw)
          .filter((p): p is string => !!p),
      ),
    ].slice(0, 20),
    accounts: [...accounts.values()],
  };
}

/** Pages worth reading after the home page, by link text or address. */
const MORE =
  /contact|about|partner|affiliat|introducing|\bib\b|regulat|licen[cs]|legal|تواصل|اتصل|من نحن|عن(ا| الشركة)|شراك|شركاء|وكلاء|وكيل|ترخيص|تراخيص/i;

const REGULATORS: [RegExp, string][] = [
  [/\bFCA\b|Financial Conduct Authority/i, "FCA"],
  [/\bCySEC\b/i, "CySEC"],
  [/\bASIC\b/i, "ASIC"],
  [/\bDFSA\b|Dubai Financial Services/i, "DFSA"],
  [/\bSCA\b|Securities and Commodities Authority|هيئة الأوراق المالية والسلع/i, "SCA"],
  [/\bCMA\b|Capital Market Authority|هيئة السوق المالية/i, "CMA"],
  [/\bFSCA\b/i, "FSCA"],
  [/\bFSA\b|(?<!Dubai )Financial Services Authority/i, "FSA"],
  [/\bCBB\b|Central Bank of Bahrain|مصرف البحرين المركزي/i, "CBB"],
  [/\bQFCRA\b|\bQFMA\b|هيئة قطر للأسواق المالية/i, "QFMA"],
  [/\bJSC\b|هيئة الأوراق المالية الأردنية/i, "JSC"],
  [/\bFSRA\b|ADGM/i, "FSRA"],
];
const PARTNER =
  /introducing broker|\bIB program|affiliate program|partner(ship)? program|become a partner|برنامج (الشراكة|الشركاء|الوكلاء)|كن شريك|انضم كوسيط|وسيط معرّف|وكيل معتمد/i;

export interface SiteAnalysis {
  url: string;
  title: string | null;
  description: string | null;
  lang: string | null;
  pages: string[];
  emails: string[];
  phones: string[];
  accounts: { platform: string; handle: string; url: string }[];
  /** Regulators the site mentions (a mention, not a verified license). */
  regulators: string[];
  partnerProgram: boolean;
}

/** Reads a site's home page and up to `extraPages` of its contact, about and partner pages. */
export async function analyzeSite(
  host: string,
  o: WebReadOptions & { extraPages?: number } = {},
): Promise<SiteAnalysis> {
  const home = await readPage(
    `https://${host.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`,
    o,
  );
  const origin = new URL(home.url).origin;
  const next = [
    ...new Set(
      home.links
        .filter((l) => l.href.startsWith(origin) && MORE.test(`${l.text} ${l.href}`))
        .map((l) => l.href.split("#")[0] as string),
    ),
  ]
    .filter((h) => h !== home.url)
    .slice(0, o.extraPages ?? 3);
  const pages = [home];
  for (const href of next) {
    try {
      pages.push(await readPage(href, o));
    } catch {
      // A page that fails or is disallowed is skipped.
    }
  }
  const all = pages.map((p) => `${p.title ?? ""}\n${p.description ?? ""}\n${p.text}`).join("\n");
  const accounts = new Map<string, { platform: string; handle: string; url: string }>();
  for (const p of pages) for (const a of p.accounts) accounts.set(`${a.platform}:${a.handle}`, a);
  return {
    url: home.url,
    title: home.title,
    description: home.description,
    lang: home.lang,
    pages: pages.map((p) => p.url),
    emails: [...new Set(pages.flatMap((p) => p.emails))].slice(0, 20),
    phones: [...new Set(pages.flatMap((p) => p.phones))].slice(0, 20),
    accounts: [...accounts.values()],
    regulators: REGULATORS.filter(([re]) => re.test(all)).map(([, name]) => name),
    partnerProgram: PARTNER.test(all),
  };
}
