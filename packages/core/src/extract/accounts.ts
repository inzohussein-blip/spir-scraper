/**
 * Accounts on other platforms that a person links from their own profile:
 * the bio text and the bio link. A link a person puts in their own bio is
 * strong evidence the account is theirs; we never guess from a name alone.
 */

export const PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "telegram",
  "x",
  "facebook",
  "linkedin",
  "snapchat",
  "threads",
  "website",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "إنستقرام",
  tiktok: "تيك توك",
  youtube: "يوتيوب",
  telegram: "تلكرام",
  x: "X",
  facebook: "فيسبوك",
  linkedin: "لينكدإن",
  snapchat: "سناب شات",
  threads: "ثريدز",
  website: "موقع",
};

export interface AccountRef {
  platform: Platform;
  /** Lower-case handle (username, channel handle, or the site's host for websites). */
  handle: string;
  /** Canonical public address of the account. */
  url: string;
}

const HANDLE = /^[a-z0-9._-]{2,60}$/;
/** Paths that are product pages, not accounts. */
const RESERVED = new Set([
  "share",
  "sharer",
  "watch",
  "results",
  "explore",
  "p",
  "reel",
  "reels",
  "stories",
  "hashtag",
  "intent",
  "home",
  "login",
  "signup",
  "joinchat",
  "addstickers",
  "s",
  "c",
  "channel",
  "user",
  "in",
  "company",
  "pages",
  "groups",
  "profile.php",
  "add",
  "discover",
  "music",
  "tag",
  "search",
  "i",
]);
/** Link-in-bio, shortener and messaging hosts that are not the person's own website. */
const NOT_WEBSITES = new Set([
  "linktr.ee",
  "beacons.ai",
  "bio.link",
  "linkin.bio",
  "lnk.bio",
  "taplink.cc",
  "campsite.bio",
  "bit.ly",
  "tinyurl.com",
  "cutt.ly",
  "wa.me",
  "api.whatsapp.com",
  "whatsapp.com",
  "wa.link",
  "linkedin.com",
  "google.com",
  "goo.gl",
  "maps.app.goo.gl",
  "apple.com",
  "apps.apple.com",
  "play.google.com",
  "forms.gle",
  "docs.google.com",
  "calendly.com",
]);

const clean = (h: string) => decodeURIComponent(h).replace(/^@/, "").toLowerCase();
const ok = (h: string) => HANDLE.test(h) && !RESERVED.has(h);

/** The platform account a URL points at, or null for posts, searches and unknown sites. */
export function parseAccountUrl(input: string): AccountRef | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  const ref = (platform: Platform, raw: string, url: (h: string) => string): AccountRef | null => {
    const handle = clean(raw);
    return ok(handle) ? { platform, handle, url: url(handle) } : null;
  };

  if (host === "instagram.com" && parts.length === 1)
    return ref("instagram", first, (h) => `https://www.instagram.com/${h}/`);
  if (host === "tiktok.com" && first.startsWith("@"))
    return ref("tiktok", first, (h) => `https://www.tiktok.com/@${h}`);
  if (host === "youtube.com" || host === "youtu.be") {
    if (first.startsWith("@")) return ref("youtube", first, (h) => `https://www.youtube.com/@${h}`);
    if ((first === "c" || first === "user") && parts[1])
      return ref("youtube", parts[1], (h) => `https://www.youtube.com/${first}/${h}`);
    if (first === "channel" && parts[1] && /^UC[\w-]{20,}$/.test(parts[1]))
      return {
        platform: "youtube",
        handle: parts[1],
        url: `https://www.youtube.com/channel/${parts[1]}`,
      };
    return null;
  }
  if ((host === "t.me" || host === "telegram.me") && parts.length === 1 && !first.startsWith("+"))
    return ref("telegram", first, (h) => `https://t.me/${h}`);
  if ((host === "x.com" || host === "twitter.com") && parts.length === 1)
    return ref("x", first, (h) => `https://x.com/${h}`);
  if ((host === "facebook.com" || host === "fb.com") && parts.length === 1)
    return ref("facebook", first, (h) => `https://www.facebook.com/${h}`);
  if (host === "linkedin.com" && (first === "in" || first === "company") && parts[1])
    return ref("linkedin", parts[1], (h) => `https://www.linkedin.com/${first}/${h}`);
  if (host === "snapchat.com" && first === "add" && parts[1])
    return ref("snapchat", parts[1], (h) => `https://www.snapchat.com/add/${h}`);
  if (host === "threads.net" && first.startsWith("@"))
    return ref("threads", first, (h) => `https://www.threads.net/@${h}`);

  const known = [
    "instagram.com",
    "tiktok.com",
    "t.me",
    "telegram.me",
    "x.com",
    "twitter.com",
    "facebook.com",
    "fb.com",
    "snapchat.com",
    "threads.net",
  ];
  if (known.includes(host) || NOT_WEBSITES.has(host) || !host.includes(".")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  return { platform: "website", handle: host, url: `https://${host}` };
}

/** Labels people write before a handle, e.g. "TikTok: @x" or "تلكرام @x". */
const LABELLED: { platform: Platform; words: string; url: (h: string) => string }[] = [
  {
    platform: "tiktok",
    words: "tiktok|tik tok|تيك ?توك|تك ?توك",
    url: (h) => `https://www.tiktok.com/@${h}`,
  },
  {
    platform: "telegram",
    words: "telegram|tg|تلكرام|تليجرام|تيليجرام|تلغرام",
    url: (h) => `https://t.me/${h}`,
  },
  { platform: "youtube", words: "youtube|yt|يوتيوب", url: (h) => `https://www.youtube.com/@${h}` },
  {
    platform: "snapchat",
    words: "snapchat|snap|سناب ?شات|سناب",
    url: (h) => `https://www.snapchat.com/add/${h}`,
  },
  { platform: "x", words: "twitter|تويتر", url: (h) => `https://x.com/${h}` },
];

/** Every other-platform account linked from a bio and its link. */
export function linkedAccounts(
  bio: string | null | undefined,
  externalUrl?: string | null,
): AccountRef[] {
  const found = new Map<string, AccountRef>();
  const add = (r: AccountRef | null) => {
    if (r) found.set(`${r.platform}:${r.handle}`, r);
  };
  if (externalUrl) add(parseAccountUrl(externalUrl));
  const text = bio ?? "";
  const urls =
    text.match(
      /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|net|org|me|io|ai|co|app|be|sa|ae|kw|qa|eg|info|biz|store|shop|online|link|ly)(?:\/[^\s,،)]*)?/gi,
    ) ?? [];
  for (const url of urls) {
    // An email's domain is not a website link.
    const at = text.indexOf(url);
    if (at > 0 && text[at - 1] === "@") continue;
    add(parseAccountUrl(url));
  }
  for (const l of LABELLED) {
    // The label stands alone ("tiktok.com" in a URL is not a label) and a separator,
    // a space or @ comes before the handle.
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}._/])(?:${l.words})(?:\\s*[:：\\-–]\\s*@?|\\s+@?|@)([a-z0-9][a-z0-9._]{1,29})`,
      "giu",
    );
    for (const m of text.matchAll(re)) {
      const h = clean(m[1] as string);
      if (ok(h)) add({ platform: l.platform, handle: h, url: l.url(h) });
    }
  }
  return [...found.values()];
}
