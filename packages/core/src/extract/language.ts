/**
 * The main language of a name and bio, from the letters used. A cheap
 * heuristic (no model): good enough to filter "Arabic accounts only".
 */
export function detectLanguage(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/https?:\/\/\S+|@\w+|#\S+/g, " ");
  const count = (re: RegExp) => t.match(re)?.length ?? 0;
  const arabicScript = count(/[؀-ۿݐ-ݿ]/g);
  const latin = count(/[A-Za-zÀ-ɏ]/g);
  const cyrillic = count(/[Ѐ-ӿ]/g);
  const max = Math.max(arabicScript, latin, cyrillic);
  if (max < 3) return null;
  if (max === arabicScript) {
    // Letters used in Persian and Urdu but not in Arabic.
    return count(/[پچژگ]/g) >= 2 ? "fa" : "ar";
  }
  if (max === cyrillic) return "ru";
  if (count(/[ğışĞİŞ]/g) >= 2) return "tr";
  if (count(/[àâçéèêëîïôûùœ]/gi) >= 3) return "fr";
  return "en";
}

/** Language codes shown in the dashboard. */
export const LANGUAGE_LABELS: Record<string, string> = {
  ar: "عربي",
  en: "إنجليزي",
  fa: "فارسي",
  tr: "تركي",
  fr: "فرنسي",
  ru: "روسي",
};

export interface ProfileSnapshotFields {
  businessEmail?: string | null;
  businessPhone?: string | null;
  businessWhatsapp?: string | null;
  isBusiness: boolean;
  externalUrl?: string | null;
  bio?: string | null;
}

/** What changed between two fetches of the same account that matters to a salesperson. */
export function profileChanges(
  before: ProfileSnapshotFields,
  after: ProfileSnapshotFields,
): string[] {
  const out: string[] = [];
  if (!before.businessEmail && after.businessEmail) out.push("أضاف إيميلاً");
  if (
    !before.businessPhone &&
    !before.businessWhatsapp &&
    (after.businessPhone || after.businessWhatsapp)
  )
    out.push("أضاف رقماً");
  if (!before.isBusiness && after.isBusiness) out.push("صار حساباً تجارياً");
  if (!before.externalUrl && after.externalUrl) out.push("أضاف رابطاً");
  if ((before.bio ?? "").trim() !== (after.bio ?? "").trim() && before.bio && after.bio)
    out.push("غيّر البايو");
  return out;
}
