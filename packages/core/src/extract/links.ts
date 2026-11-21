/** Hosts whose links are personal contact pages rather than websites. */
const CONTACT_HOSTS = ["wa.me", "api.whatsapp.com", "whatsapp.com", "t.me"];

/**
 * Pulls contact details out of a bio link without fetching it: mailto: and
 * tel: links, and WhatsApp links that embed the number. We never crawl sites.
 */
export function contactsFromUrl(url: string | null | undefined): {
  emails: string[];
  text: string;
} {
  if (!url) return { emails: [], text: "" };
  const trimmed = url.trim();
  if (/^mailto:/i.test(trimmed)) {
    const email = decodeURIComponent(trimmed.slice(7).split("?")[0] ?? "").toLowerCase();
    return { emails: email ? [email] : [], text: "" };
  }
  if (/^tel:/i.test(trimmed)) return { emails: [], text: trimmed };
  try {
    const u = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const host = u.hostname.replace(/^www\./, "");
    if (CONTACT_HOSTS.includes(host))
      return { emails: [], text: `${host}${u.pathname}${u.search}` };
  } catch {
    // Not a URL: nothing to extract.
  }
  return { emails: [], text: "" };
}
