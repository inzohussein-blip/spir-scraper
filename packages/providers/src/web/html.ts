/** Small, dependency-free HTML reading: title, meta, links and readable text. */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : null;
};

export interface ParsedPage {
  title: string | null;
  description: string | null;
  lang: string | null;
  links: { href: string; text: string }[];
  /** Readable text, one block per line. */
  text: string;
}

export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const meta = (key: string) => {
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const tag = m[0];
      if ((attr(tag, "name") ?? attr(tag, "property"))?.toLowerCase() === key)
        return attr(tag, "content")?.trim() || null;
    }
    return null;
  };
  const title =
    decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
      .replace(/\s+/g, " ")
      .trim() || meta("og:title");
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const links: { href: string; text: string }[] = [];
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1] ?? "", "href");
    if (!href || /^(javascript|data):/i.test(href)) continue;
    let abs = href;
    try {
      abs = /^(mailto|tel):/i.test(href) ? href : new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    const text = decodeEntities((m[2] ?? "").replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    links.push({ href: abs, text: text.slice(0, 120) });
  }
  const text = decodeEntities(
    body
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(
        /<\/(p|div|li|h[1-6]|tr|section|article|header|footer|nav|ul|ol|table|blockquote)>/gi,
        "\n",
      )
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return {
    title: title || null,
    description: meta("description") ?? meta("og:description"),
    lang: attr(/<html\b[^>]*>/i.exec(html)?.[0] ?? "", "lang"),
    links,
    text,
  };
}
