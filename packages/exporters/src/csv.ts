import type { LeadRow } from "@scrapers/core";
import { stringify } from "csv-stringify/sync";
import { COLUMNS, toMatrix } from "./columns.js";

/** UTF-8 CSV with a BOM so Excel shows Arabic correctly. */
export function toCsv(rows: readonly LeadRow[], opts: { headers?: "ar" | "keys" } = {}): string {
  const header = COLUMNS.map((c) => (opts.headers === "keys" ? c.key : c.header));
  return `﻿${stringify([header, ...toMatrix(rows)], { record_delimiter: "\r\n" })}`;
}
