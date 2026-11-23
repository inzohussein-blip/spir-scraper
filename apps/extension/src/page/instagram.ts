/**
 * Pure helpers for reading Instagram pages (no DOM access here, so they are
 * unit tested). The content script feeds them hrefs, meta tags and text.
 */

const USERNAME = /^[a-z0-9._]{1,30}$/;
/** First path segments that are Instagram pages, not accounts. */
const RESERVED = new Set([
  "explore",
  "accounts",
  "p",
  "reel",
  "reels",
  "tv",
  "stories",
  "direct",
  "about",
  "legal",
  "developer",
  "web",
  "emails",
  "challenge",
  "privacy",
  "help",
]);

export function isInstagramHost(host: string): boolean {
  return host === "instagram.com" || host.endsWith(".instagram.com");
}

/** The account a profile URL points at, or null for posts, explore, etc. */
export function usernameFromPath(path: string): string | null {
  const m = /^\/([^/?#]+)\/?(?:followers\/?|following\/?)?$/.exec(path);
  const u = m?.[1]?.toLowerCase();
  if (!u || RESERVED.has(u) || !USERNAME.test(u) || u.startsWith(".") || u.endsWith("."))
    return null;
  return u;
}

/** Usernames from the links of an open followers/following/likes list. */
export function usernamesFromHrefs(hrefs: readonly string[], exclude?: string | null): string[] {
  const out = new Set<string>();
  for (const href of hrefs) {
    let path = href;
    try {
      const u = new URL(href, "https://www.instagram.com");
      if (!isInstagramHost(u.hostname)) continue;
      path = u.pathname;
    } catch {
      continue;
    }
    const name = /^\/([^/?#]+)\/?$/.exec(path)?.[1]?.toLowerCase();
    if (!name || RESERVED.has(name) || !USERNAME.test(name) || name === exclude) continue;
    out.add(name);
  }
  return [...out];
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
export function latinDigits(s: string): string {
  return s.replace(ARABIC_DIGITS, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/** "1.2M" → 1200000, "12K" → 12000, "1,234" → 1234, "3.5 ألف" → 3500. */
export function parseCount(raw: string): number | null {
  const s = latinDigits(raw).trim().toLowerCase().replace(/,/g, "").replace(/٬/g, "");
  const m = /^([\d.]+)\s*(k|m|b|ألف|مليون|مليار)?/.exec(s);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult: Record<string, number> = {
    k: 1e3,
    m: 1e6,
    b: 1e9,
    ألف: 1e3,
    مليون: 1e6,
    مليار: 1e9,
  };
  return Math.round(n * (m[2] ? (mult[m[2]] ?? 1) : 1));
}

/**
 * Reads counts from Instagram's og:description, e.g.
 * "1M Followers, 10 Following, 100 Posts - See Instagram photos and videos from Name (@user)".
 */
export function parseOgDescription(desc: string): {
  followers: number | null;
  following: number | null;
  posts: number | null;
} {
  const grab = (re: RegExp) => {
    const m = re.exec(desc);
    return m?.[1] ? parseCount(m[1]) : null;
  };
  return {
    followers: grab(/([\d.,٠-٩]+\s*[KkMmBb]?)\s*(?:Followers|follower|متابِع|متابع)/),
    following: grab(/([\d.,٠-٩]+\s*[KkMmBb]?)\s*(?:Following|يتابع|متابَع)/),
    posts: grab(/([\d.,٠-٩]+\s*[KkMmBb]?)\s*(?:Posts|post|منشور)/),
  };
}

/** "Name (@user) • Instagram photos and videos" → { name, username }. */
export function parseOgTitle(title: string): { name: string | null; username: string | null } {
  const m = /^(.*?)\s*\(@([A-Za-z0-9._]{1,30})\)/.exec(title);
  if (!m) return { name: null, username: null };
  return { name: m[1]?.trim() || null, username: m[2]?.toLowerCase() ?? null };
}

const EMAIL =
  /[A-Za-z0-9._%+-]+\s*(?:@|\[at\]|\(at\)| at )\s*[A-Za-z0-9.-]+\s*(?:\.|\[dot\]|\(dot\)| dot )\s*[A-Za-z]{2,}/gi;

/** Emails and phone numbers written in a bio, including "name [at] site [dot] com" and Arabic digits. */
export function contactsFromText(text: string): { emails: string[]; phones: string[] } {
  const t = latinDigits(text);
  const emails = new Set<string>();
  for (const m of t.matchAll(EMAIL)) {
    emails.add(
      m[0]
        .replace(/\s*(?:\[at\]|\(at\)| at )\s*/i, "@")
        .replace(/\s*(?:\[dot\]|\(dot\)| dot )\s*/gi, ".")
        .replace(/\s+/g, "")
        .toLowerCase(),
    );
  }
  const phones = new Set<string>();
  for (const m of t.matchAll(/\+?\d[\d\s\-().]{7,18}\d/g)) {
    const digits = m[0].replace(/[^\d+]/g, "");
    if (digits.replace("+", "").length >= 8) phones.add(digits);
  }
  return { emails: [...emails], phones: [...phones] };
}

/**
 * Words in a comment that show buying intent ("how much", "I want", "DM me").
 * Matched on letters only, so "بكم؟" and "Price??" count.
 */
export const INTENT_WORDS = [
  "بكم",
  "كم السعر",
  "السعر",
  "الاسعار",
  "الأسعار",
  "كيف اشترك",
  "كيف أشترك",
  "كيف ابدا",
  "كيف أبدأ",
  "ابي",
  "أبي",
  "ابغى",
  "أبغى",
  "ودي",
  "مهتم",
  "مهتمة",
  "تواصل",
  "خاص",
  "الخاص",
  "رقمك",
  "واتساب",
  "وتساب",
  "الرابط",
  "التفاصيل",
  "تفاصيل",
  "عايز",
  "عاوز",
  "اريد",
  "أريد",
  "price",
  "how much",
  "interested",
  "dm",
  "inbox",
  "details",
  "info",
  "link",
  "join",
  "whatsapp",
  "contact",
];

const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[إأآ]/g, "ا")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

/** The intent words a comment contains (normalised alef forms, whole words). */
export function commentIntent(text: string): string[] {
  const t = norm(text);
  const hits = new Set<string>();
  for (const w of INTENT_WORDS) {
    const k = norm(w);
    if (t.includes(k)) hits.add(w.replace(/[إأآ]/g, "ا"));
  }
  return [...hits];
}

export interface PostComment {
  username: string;
  text: string;
  intent: string[];
}

/**
 * Comments from the visible comment blocks of a post: each block's first
 * profile link is the author, the rest of its text is the comment. The post's
 * owner and repeated authors are left out. Comments with intent come first.
 */
export function parseComments(
  blocks: readonly { hrefs: readonly string[]; text: string }[],
  owner?: string | null,
): PostComment[] {
  const out = new Map<string, PostComment>();
  for (const b of blocks) {
    const [author] = usernamesFromHrefs(b.hrefs.slice(0, 2), owner);
    if (!author) continue;
    const text = b.text
      .replace(new RegExp(`^\\s*${author.replace(/[.]/g, "\\.")}\\s*(?:✓|Verified)?`, "i"), "")
      .replace(
        /\s*(\d+\s*(?:[smhdw]|ث|د|س|ي|أ)\b|Reply|رد|Like|إعجاب|See translation|عرض الترجمة)\s*/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    if (!text) continue;
    const prev = out.get(author);
    const intent = commentIntent(text);
    if (prev) {
      prev.intent = [...new Set([...prev.intent, ...intent])];
      continue;
    }
    out.set(author, { username: author, text, intent });
  }
  return [...out.values()].sort((a, b) => b.intent.length - a.intent.length);
}

/** The shortcode of a post or reel URL, or null. */
export function postFromPath(path: string): string | null {
  return /^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})\/?/.exec(path)?.[1] ?? null;
}
