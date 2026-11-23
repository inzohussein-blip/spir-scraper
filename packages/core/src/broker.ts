/**
 * Broker reports in whatever shape the affiliate system sends them
 * (CellXpert, MyAffiliates, Income Access, a CSV export): field names vary,
 * so each value is looked up by its common aliases, Arabic included.
 */

export type BrokerEventType = "registration" | "ftd" | "deposit" | "trade" | "commission";

export interface BrokerEventInput {
  event: BrokerEventType;
  externalId: string | null;
  email: string | null;
  phone: string | null;
  amount: number | null;
  currency: string | null;
  sub: string | null;
  at: Date | null;
}

const ALIASES: Record<keyof Omit<BrokerEventInput, "event"> | "event", string[]> = {
  event: ["event", "type", "action", "goal", "status", "الحدث", "النوع"],
  externalId: [
    "client_id",
    "clientid",
    "customer_id",
    "player_id",
    "trader_id",
    "account_id",
    "uid",
    "user_id",
    "id",
    "رقم العميل",
    "رقم الحساب",
  ],
  email: ["email", "mail", "e-mail", "customer_email", "البريد", "الإيميل", "البريد الإلكتروني"],
  phone: ["phone", "tel", "mobile", "phone_number", "الهاتف", "الجوال", "رقم الهاتف"],
  amount: [
    "amount",
    "value",
    "payout",
    "commission",
    "deposit",
    "sum",
    "revenue",
    "المبلغ",
    "العمولة",
    "الإيداع",
    "القيمة",
  ],
  currency: ["currency", "cur", "العملة"],
  sub: [
    "sub",
    "subid",
    "sub_id",
    "aff_sub",
    "afp",
    "clickid",
    "click_id",
    "tracking",
    "ref",
    "partner",
    "tracking_code",
    "الكود",
  ],
  at: ["date", "time", "datetime", "created", "created_at", "timestamp", "التاريخ"],
};

const EVENTS: [RegExp, BrokerEventType][] = [
  [/^(ftd|first[_\s-]?deposit|أول إيداع|اول ايداع)$/i, "ftd"],
  [/^(reg|registration|signup|sign[_\s-]?up|lead|account|تسجيل)$/i, "registration"],
  [/^(dep|deposit|إيداع|ايداع|redeposit)$/i, "deposit"],
  [/^(trade|trades|lots?|volume|تداول)$/i, "trade"],
  [/^(commission|payout|cpa|revshare|rev_share|عمولة)$/i, "commission"],
];

const norm = (k: string) =>
  k
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

function pick(row: Record<string, string>, key: keyof typeof ALIASES): string | null {
  const byNorm = new Map(Object.entries(row).map(([k, v]) => [norm(k), v]));
  for (const a of ALIASES[key]) {
    const v = byNorm.get(norm(a));
    // Unfilled macros like {email} are empty values.
    if (v !== undefined && v.trim() !== "" && !/^\{.*\}$/.test(v.trim())) return v.trim();
  }
  return null;
}

/** One report line or postback, or null when it names no known event. */
export function parseBrokerEvent(
  row: Record<string, string>,
  defaultEvent?: BrokerEventType,
): BrokerEventInput | null {
  const raw = pick(row, "event");
  const event = raw ? EVENTS.find(([re]) => re.test(raw.trim()))?.[1] : defaultEvent;
  if (!event) return null;
  const amountRaw = pick(row, "amount");
  const amount = amountRaw ? Number(amountRaw.replace(/[^\d.-]/g, "")) : null;
  const atRaw = pick(row, "at");
  const at = atRaw ? new Date(/^\d{9,10}$/.test(atRaw) ? Number(atRaw) * 1000 : atRaw) : null;
  const email = pick(row, "email")?.toLowerCase() ?? null;
  return {
    event,
    externalId: pick(row, "externalId"),
    email: email?.includes("@") ? email : null,
    phone: pick(row, "phone"),
    amount: amount !== null && Number.isFinite(amount) ? amount : null,
    currency: pick(row, "currency")?.toUpperCase() ?? null,
    sub: pick(row, "sub"),
    at: at && !Number.isNaN(at.getTime()) ? at : null,
  };
}

/** Splits CSV text into rows of header → value (quotes, commas and semicolons handled). */
export function parseCsvRows(text: string): Record<string, string>[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!header) return [];
  const keys = header.map((h) => h.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/**
 * A broker CSV export as events. A line with both a deposit and a commission
 * becomes two events; `defaultEvent` covers reports without an event column.
 */
export function parseBrokerCsv(
  text: string,
  defaultEvent: BrokerEventType = "commission",
): BrokerEventInput[] {
  const out: BrokerEventInput[] = [];
  for (const row of parseCsvRows(text)) {
    const keys = Object.keys(row).map(norm);
    const has = (names: string[]) => names.some((n) => keys.includes(norm(n)));
    const hasEvent = has(ALIASES.event);
    const deposit = has(["deposit", "ftd", "first_deposit", "الإيداع", "أول إيداع"]);
    const commission = has(["commission", "payout", "العمولة"]);
    if (!hasEvent && deposit && commission) {
      const depositRow = { ...row };
      const commissionRow = { ...row };
      for (const k of Object.keys(row)) {
        if (["commission", "payout", "العمولة"].includes(norm(k))) delete depositRow[k];
        if (["deposit", "ftd", "first_deposit", "الإيداع", "أول إيداع"].map(norm).includes(norm(k)))
          delete commissionRow[k];
      }
      const d = parseBrokerEvent(
        {
          ...depositRow,
          amount: depositRow.ftd ?? depositRow.deposit ?? depositRow["الإيداع"] ?? "",
        },
        "ftd",
      );
      const c = parseBrokerEvent(commissionRow, "commission");
      if (d?.amount) out.push(d);
      if (c?.amount) out.push(c);
      continue;
    }
    const e = parseBrokerEvent(row, hasEvent ? undefined : deposit ? "ftd" : defaultEvent);
    if (e) out.push(e);
  }
  return out;
}
