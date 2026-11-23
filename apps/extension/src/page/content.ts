import {
  contactsFromText,
  parseComments,
  parseOgDescription,
  parseOgTitle,
  postFromPath,
  usernameFromPath,
  usernamesFromHrefs,
} from "./instagram.js";
import type { CollectState, InstagramProfile, PageRequest, PageResponse } from "./protocol.js";

/**
 * Injected into the tab on demand by the side panel. It reads the page and
 * performs single actions; it never acts by itself.
 */
type Win = typeof window & { __spirAgent?: boolean };
const w = window as Win;

const ATTR = "data-spir-id";
const MAX_ELEMENTS = 150;
const MAX_TEXT = 6000;
/** Fields the agent must never fill. */
const SENSITIVE = /pass|card|cc-|cvv|cvc|otp|one-time|security.?code|iban|pin\b/i;

let elements = new Map<number, Element>();
const collect: CollectState = { collecting: false, usernames: [], owner: null };
const seen = new Set<string>();
let observer: MutationObserver | null = null;

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

function isScrollable(el: Element): boolean {
  if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 20) return false;
  const o = getComputedStyle(el).overflowY;
  return o === "auto" || o === "scroll";
}

function isSensitive(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === "password") return true;
  const attrs = ["name", "id", "autocomplete", "aria-label", "placeholder"]
    .map((a) => el.getAttribute(a) ?? "")
    .join(" ");
  return SENSITIVE.test(attrs);
}

/** The text a person sees on the element. */
function rendered(el: Element): string {
  // biome-ignore lint/performance/useDomNodeTextContent: innerText is the rendered text (no hidden parts, real line breaks), which is what the model should read
  return el instanceof HTMLElement ? el.innerText : (el.textContent ?? "");
}

function label(el: Element): string {
  const text =
    el.getAttribute("aria-label") ||
    rendered(el) ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    el.getAttribute("alt") ||
    el.getAttribute("name") ||
    "";
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

const INTERACTIVE =
  "a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], " +
  "[role=menuitem], [role=checkbox], [role=option], [contenteditable=true], [onclick]";

function snapshot(): string {
  for (const e of document.querySelectorAll(`[${ATTR}]`)) e.removeAttribute(ATTR);
  elements = new Map();
  const candidates = [...document.querySelectorAll(INTERACTIVE)].filter(visible);
  // Scrollable containers (a followers dialog, a feed) can be scrolled by number.
  const scrollers = [...document.querySelectorAll("div, section, ul, main")]
    .filter((e) => isScrollable(e) && visible(e))
    .slice(0, 10);
  const ordered = [
    ...candidates.filter(inViewport),
    ...scrollers,
    ...candidates.filter((e) => !inViewport(e)),
  ].slice(0, MAX_ELEMENTS);

  const lines: string[] = [];
  let n = 0;
  for (const el of new Set(ordered)) {
    n++;
    el.setAttribute(ATTR, String(n));
    elements.set(n, el);
    const tag = el.tagName.toLowerCase();
    let desc: string;
    if (scrollers.includes(el)) desc = "scrollable area";
    else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const kind = el instanceof HTMLInputElement ? el.type : "textarea";
      desc = isSensitive(el)
        ? `input:${kind} [protected - never type here]`
        : `input:${kind} value="${el.value.slice(0, 40)}"`;
    } else if (el instanceof HTMLAnchorElement) {
      const href = el.getAttribute("href") ?? "";
      desc = `link -> ${href.slice(0, 100)}`;
    } else desc = el.getAttribute("role") || tag;
    const offscreen = inViewport(el) ? "" : " (off screen)";
    lines.push(`[${n}] ${desc} "${label(el)}"${offscreen}`);
  }

  // biome-ignore lint/performance/useDomNodeTextContent: innerText is the rendered text (no hidden parts, real line breaks), which is what the model should read
  const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, MAX_TEXT);
  return [
    `URL: ${location.href}`,
    `Title: ${document.title}`,
    "",
    '<page_content untrusted="true">',
    text,
    "</page_content>",
    "",
    "Interactive elements:",
    ...lines,
  ].join("\n");
}

function target(id: number): Element {
  const el = elements.get(id) ?? document.querySelector(`[${ATTR}="${id}"]`);
  if (!el?.isConnected) throw new Error(`العنصر ${id} غير موجود؛ اقرأ الصفحة من جديد`);
  return el;
}

function click(id: number): string {
  const el = target(id);
  if (el instanceof HTMLElement) el.scrollIntoView({ block: "center" });
  (el as HTMLElement).click();
  return `clicked [${id}] ${label(el)}`;
}

function typeText(id: number, text: string, submit?: boolean): string {
  const el = target(id);
  if (isSensitive(el)) throw new Error("هذا حقل محمي (كلمة مرور أو دفع)؛ لا أكتب فيه");
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    // The native setter keeps React and similar frameworks in sync.
    const proto =
      el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    el.focus();
    document.execCommand("insertText", false, text);
  } else throw new Error("هذا العنصر لا يقبل الكتابة");
  if (submit) {
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    const form = (el as HTMLInputElement).form;
    if (form) form.requestSubmit();
  }
  return `typed into [${id}]`;
}

function scroll(direction: "down" | "up", id?: number): string {
  const sign = direction === "down" ? 1 : -1;
  if (id !== undefined) {
    let el: Element | null = target(id);
    while (el && !isScrollable(el)) el = el.parentElement;
    if (!el) throw new Error(`العنصر ${id} لا يتمرر`);
    el.scrollBy({ top: sign * el.clientHeight * 0.8 });
    return `scrolled [${id}] ${direction}`;
  }
  window.scrollBy({ top: sign * innerHeight * 0.8 });
  return `scrolled page ${direction}`;
}

function meta(prop: string): string {
  return (
    document.querySelector(`meta[property="${prop}"]`)?.getAttribute("content") ??
    document.querySelector(`meta[name="${prop}"]`)?.getAttribute("content") ??
    ""
  );
}

function instagramProfile(): InstagramProfile {
  const username = usernameFromPath(location.pathname);
  if (!username) throw new Error("الصفحة ليست حساباً على إنستقرام");
  const title = parseOgTitle(meta("og:title"));
  const counts = parseOgDescription(meta("og:description") || meta("description"));
  const header = document.querySelector("header");
  // biome-ignore lint/performance/useDomNodeTextContent: innerText is the rendered text (no hidden parts, real line breaks), which is what the model should read
  const headerText = (header as HTMLElement | null)?.innerText ?? "";
  // The bio is the header text after the stats line; keep it short.
  const bio = headerText.split("\n").slice(3).join("\n").trim().slice(0, 600) || null;
  const external = [...(header?.querySelectorAll("a[href]") ?? [])]
    .map((a) => a.getAttribute("href") ?? "")
    .find((h) => /^https?:/.test(h) && !h.includes("instagram.com"));
  const contacts = contactsFromText(headerText);
  return {
    username: title.username ?? username,
    name: title.name,
    bio,
    ...counts,
    externalUrl: external ?? null,
    emails: contacts.emails,
    phones: contacts.phones,
    url: location.href,
  };
}

/** Usernames in the open dialog (followers list), or the page when no dialog is open. */
function harvest() {
  const scope = document.querySelector('[role="dialog"]') ?? document;
  const hrefs = [...scope.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
  for (const u of usernamesFromHrefs(hrefs, collect.owner)) {
    if (!seen.has(u)) {
      seen.add(u);
      collect.usernames.push(u);
    }
  }
}

function startCollect(): CollectState {
  collect.owner = usernameFromPath(location.pathname);
  collect.collecting = true;
  harvest();
  observer?.disconnect();
  observer = new MutationObserver(() => harvest());
  observer.observe(document.body, { childList: true, subtree: true });
  return collect;
}

function clearCollect(): CollectState {
  observer?.disconnect();
  observer = null;
  seen.clear();
  collect.usernames = [];
  collect.collecting = false;
  return collect;
}

/**
 * Visible comments on an open post or reel. Each comment block is the nearest
 * list item (or small container) around an author link.
 */
function postComments() {
  if (!postFromPath(location.pathname)) throw new Error("افتح منشوراً أو ريلز أولاً");
  const scope =
    document.querySelector('[role="dialog"] article, [role="dialog"]') ??
    document.querySelector("main") ??
    document;
  const ownerLink = scope.querySelector("header a[href]")?.getAttribute("href") ?? "";
  const owner = usernamesFromHrefs([ownerLink])[0] ?? null;
  const blocks: { hrefs: string[]; text: string }[] = [];
  const used = new Set<Element>();
  for (const a of scope.querySelectorAll("a[href]")) {
    if (a.closest("header")) continue;
    const href = a.getAttribute("href") ?? "";
    if (usernamesFromHrefs([href]).length === 0) continue;
    // The smallest ancestor holding more than the name: the comment block.
    let el: Element | null = a;
    for (let i = 0; i < 6 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      if (el.tagName === "LI") break;
      // biome-ignore lint/performance/useDomNodeTextContent: rendered text keeps line breaks
      const t = (el as HTMLElement).innerText ?? "";
      if (t.length > (a.textContent ?? "").length + 3) break;
    }
    if (!el || used.has(el)) continue;
    used.add(el);
    blocks.push({
      hrefs: [...el.querySelectorAll("a[href]")].map((x) => x.getAttribute("href") ?? ""),
      // biome-ignore lint/performance/useDomNodeTextContent: rendered text keeps line breaks
      text: (el as HTMLElement).innerText ?? "",
    });
  }
  return { post: location.href, owner, comments: parseComments(blocks, owner) };
}

function handle(req: PageRequest): PageResponse {
  switch (req.kind) {
    case "snapshot":
      return { ok: true, text: snapshot() };
    case "click":
      return { ok: true, text: click(req.id) };
    case "type":
      return { ok: true, text: typeText(req.id, req.text, req.submit) };
    case "scroll":
      return { ok: true, text: scroll(req.direction, req.id) };
    case "instagram_profile":
      return { ok: true, data: instagramProfile() };
    case "collect_start":
      return { ok: true, data: startCollect() };
    case "collect_get":
      if (collect.collecting) harvest();
      return { ok: true, data: collect };
    case "collect_clear":
      return { ok: true, data: clearCollect() };
    case "post_comments":
      return { ok: true, data: postComments() };
    case "page_meta":
      return {
        ok: true,
        data: {
          url: location.href,
          title: meta("og:title") || document.title || null,
          description: meta("og:description") || meta("description") || null,
        },
      };
  }
}

if (!w.__spirAgent) {
  w.__spirAgent = true;
  chrome.runtime.onMessage.addListener((req: PageRequest, _sender, reply) => {
    try {
      reply(handle(req));
    } catch (err) {
      reply({ ok: false, error: (err as Error).message } satisfies PageResponse);
    }
    return false;
  });
}
