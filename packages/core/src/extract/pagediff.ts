/** Line-level change between two readings of the same page. */
export function pageDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const norm = (t: string) =>
    t
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      // Very short lines (menu items, counters) are noise.
      .filter((l) => l.length >= 4);
  const a = norm(before);
  const b = norm(after);
  const inA = new Set(a);
  const inB = new Set(b);
  return {
    added: [...new Set(b.filter((l) => !inA.has(l)))],
    removed: [...new Set(a.filter((l) => !inB.has(l)))],
  };
}

/** Text with numbers that change on every visit (dates, times, visitor counts) left in place. */
export function normalizePageText(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
