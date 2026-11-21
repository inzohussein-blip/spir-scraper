import type { LeadRow } from "@scrapers/core";

export interface Column {
  key: string;
  /** Arabic header shown in files and sheets; `key` stays the stable machine name. */
  header: string;
  width: number;
  value: (r: LeadRow) => string | number | null;
}

/** The fixed column order shared by CSV, XLSX and Google Sheets (docs/PLAN.md §9). */
export const COLUMNS: readonly Column[] = [
  { key: "username", header: "المعرّف", width: 22, value: (r) => r.username },
  { key: "full_name", header: "الاسم", width: 24, value: (r) => r.fullName },
  { key: "category", header: "التصنيف", width: 20, value: (r) => r.category },
  { key: "followers", header: "المتابعون", width: 12, value: (r) => r.followers },
  { key: "email", header: "الإيميل", width: 28, value: (r) => r.email },
  { key: "phone", header: "الهاتف", width: 18, value: (r) => r.phone },
  { key: "phone_country", header: "دولة الرقم", width: 10, value: (r) => r.phoneCountry },
  {
    key: "phone_confirmed",
    header: "الرقم مؤكد",
    width: 10,
    value: (r) => (r.phone ? (r.phoneConfirmed ? "نعم" : "لا") : null),
  },
  { key: "contact_source", header: "مصدر التواصل", width: 16, value: (r) => r.contactSource },
  { key: "ai_score", header: "الدرجة", width: 8, value: (r) => r.aiScore },
  { key: "ai_tags", header: "الوسوم", width: 22, value: (r) => r.aiTags?.join("، ") ?? null },
  { key: "ai_reason", header: "سبب الدرجة", width: 36, value: (r) => r.aiReason },
  {
    key: "profile_url",
    header: "رابط الحساب",
    width: 34,
    value: (r) => `https://www.instagram.com/${r.username}/`,
  },
  { key: "source_url", header: "المصدر", width: 34, value: (r) => r.sourceUrl },
  { key: "fetched_at", header: "تاريخ الجمع", width: 20, value: (r) => r.fetchedAt.toISOString() },
];

/** Cells starting with these characters are run as formulas by spreadsheet apps. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutralises CSV/formula injection: a bio-derived value like "=HYPERLINK(...)"
 * is prefixed with an apostrophe so it is shown, not executed. Phone numbers
 * starting with "+" are kept as they are.
 */
export function safeCell(v: string | number | null): string | number | null {
  if (typeof v !== "string" || !FORMULA_START.test(v)) return v;
  if (/^\+\d[\d\s-]*$/.test(v)) return v;
  return `'${v}`;
}

export function toMatrix(
  rows: readonly LeadRow[],
  opts: { escapeFormulas?: boolean } = {},
): (string | number | null)[][] {
  const escapeCells = opts.escapeFormulas ?? true;
  return rows.map((r) => COLUMNS.map((c) => (escapeCells ? safeCell(c.value(r)) : c.value(r))));
}
