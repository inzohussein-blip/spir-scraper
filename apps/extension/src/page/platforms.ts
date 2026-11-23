/** Account pages on platforms other than Instagram, read from the address. */

export type OtherPlatform =
  | "tiktok"
  | "youtube"
  | "telegram"
  | "x"
  | "facebook"
  | "linkedin"
  | "threads";

export const PLATFORM_NAMES: Record<OtherPlatform, string> = {
  tiktok: "تيك توك",
  youtube: "يوتيوب",
  telegram: "تلكرام",
  x: "X",
  facebook: "فيسبوك",
  linkedin: "لينكدإن",
  threads: "ثريدز",
};

const RESERVED = new Set([
  "home",
  "explore",
  "search",
  "watch",
  "results",
  "messages",
  "notifications",
  "settings",
  "i",
  "intent",
  "share",
  "login",
  "signup",
  "feed",
  "groups",
  "pages",
  "hashtag",
  "tag",
  "discover",
  "s",
]);

/** The account an address on another platform points at, or null. */
export function otherAccountFromUrl(
  href: string,
): { platform: OtherPlatform; handle: string; url: string } | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const first = decodeURIComponent(parts[0] ?? "");
  const clean = (h: string) => h.replace(/^@/, "").toLowerCase();
  const ok = (h: string) => /^[a-z0-9._-]{2,60}$/.test(h) && !RESERVED.has(h);
  const make = (platform: OtherPlatform, raw: string, url: (h: string) => string) => {
    const h = clean(raw);
    return ok(h) ? { platform, handle: h, url: url(h) } : null;
  };
  if (host === "tiktok.com" && first.startsWith("@"))
    return make("tiktok", first, (h) => `https://www.tiktok.com/@${h}`);
  if (host === "youtube.com" && first.startsWith("@"))
    return make("youtube", first, (h) => `https://www.youtube.com/@${h}`);
  if ((host === "t.me" || host === "web.telegram.org") && parts.length === 1)
    return make("telegram", first, (h) => `https://t.me/${h}`);
  if ((host === "x.com" || host === "twitter.com") && parts.length >= 1)
    return make("x", first, (h) => `https://x.com/${h}`);
  if (host === "facebook.com" && parts.length === 1)
    return make("facebook", first, (h) => `https://www.facebook.com/${h}`);
  if (host === "linkedin.com" && (first === "in" || first === "company") && parts[1])
    return make("linkedin", parts[1], (h) => `https://www.linkedin.com/${first}/${h}`);
  if (host === "threads.net" && first.startsWith("@"))
    return make("threads", first, (h) => `https://www.threads.net/@${h}`);
  return null;
}
