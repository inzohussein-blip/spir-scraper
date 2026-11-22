import { normalizeBio } from "../normalize.js";
import { findEmails } from "./emails.js";
import { phonesFromLinks } from "./phones.js";

/**
 * Link-in-bio services whose public pages list a person's contact links.
 * Only these hosts are ever fetched: we do not crawl websites.
 */
export const LINK_PAGE_HOSTS = new Set([
  "linktr.ee",
  "beacons.ai",
  "taplink.cc",
  "taplink.ws",
  "lnk.bio",
  "bio.link",
  "linkin.bio",
  "campsite.bio",
  "solo.to",
  "msha.ke",
]);

export function isLinkPage(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return (
      u.protocol === "https:" &&
      LINK_PAGE_HOSTS.has(u.hostname.replace(/^www\./, "")) &&
      u.pathname.length > 1
    );
  } catch {
    return false;
  }
}

export interface LinkPageContacts {
  emails: string[];
  /** Text with wa.me / tel: links, ready for findPhones. */
  phoneText: string;
}

/** Pulls emails and WhatsApp/tel links out of a link-in-bio page's HTML. */
export function contactsFromLinkPageHtml(html: string): LinkPageContacts {
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => {
    try {
      return decodeURIComponent((m[1] ?? "").replace(/&amp;/g, "&"));
    } catch {
      return m[1] ?? "";
    }
  });
  const emails = new Set<string>();
  for (const h of hrefs) {
    if (/^mailto:/i.test(h)) {
      const e = h.slice(7).split("?")[0]?.trim().toLowerCase();
      if (e) for (const x of findEmails(e)) emails.add(x);
    }
  }
  const text = normalizeBio(
    html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " "),
  );
  for (const e of findEmails(text)) emails.add(e);
  const phoneLinks = hrefs.filter((h) => /wa\.me\/|whatsapp\.com\/send|^tel:/i.test(h));
  return { emails: [...emails], phoneText: phonesFromLinks(phoneLinks.join(" ")).join(" ") };
}

export type LinkPageFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetches a link-in-bio page with a short timeout and size cap. Redirects
 * are only followed when they stay on an allowed host.
 */
export async function fetchLinkPage(
  url: string,
  fetchImpl: LinkPageFetch = globalThis.fetch,
): Promise<LinkPageContacts | null> {
  if (!isLinkPage(url)) return null;
  let target = url.startsWith("http") ? url : `https://${url}`;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetchImpl(target, {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; ScrapersBot/1.0)", accept: "text/html" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return null;
      target = new URL(next, target).toString();
      if (!isLinkPage(target)) return null;
      continue;
    }
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 512_000);
    return contactsFromLinkPageHtml(html);
  }
  return null;
}
