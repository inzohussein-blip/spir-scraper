/** Buying-intent words in a comment or message (Arabic dialects and English), whole words only. */
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
