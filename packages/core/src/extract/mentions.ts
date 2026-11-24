/** Instagram usernames mentioned with @ in a bio or caption ("شريكنا @gold.academy"). */
export function mentionsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w.@])@([A-Za-z0-9._]{1,30})/g)) {
    const u = (m[1] as string).toLowerCase().replace(/\.+$/, "");
    if (u.length > 0 && !u.startsWith(".") && !u.includes("..") && /[a-z0-9_]/.test(u)) out.add(u);
  }
  return [...out];
}
