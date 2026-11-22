import type { LeadRow } from "@scrapers/core";
import { JWT } from "google-auth-library";
import { COLUMNS, toMatrix } from "./columns.js";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3/files";

/** Minimal authenticated request function, so tests can replace Google. */
export type GoogleRequest = <T = unknown>(opts: {
  method: "GET" | "POST" | "PUT";
  url: string;
  data?: unknown;
}) => Promise<T>;

export class SheetsError extends Error {
  override name = "SheetsError";
}

/** Builds a request function from a service-account JSON (raw or base64). */
export function serviceAccountRequest(credentials: string): {
  request: GoogleRequest;
  email: string;
} {
  const json = credentials.trim().startsWith("{")
    ? credentials
    : Buffer.from(credentials, "base64").toString("utf8");
  const sa = JSON.parse(json) as { client_email: string; private_key: string };
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
    ],
  });
  const request: GoogleRequest = async (opts) => {
    const { token } = await jwt.getAccessToken();
    const res = await fetch(opts.url, {
      method: opts.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(opts.data === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(opts.data === undefined ? {} : { body: JSON.stringify(opts.data) }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (res.ok) return body as never;
    const msg = body.error?.message ?? res.statusText;
    if (res.status === 403 && /quota|storage/i.test(msg)) {
      throw new SheetsError(
        "The service account has no Drive storage to own new files. Share an existing spreadsheet with " +
          `${sa.client_email} and export with mode "new-tab" or "append" instead.`,
      );
    }
    if (res.status === 403 || res.status === 404) {
      throw new SheetsError(
        `Google Sheets ${res.status}: ${msg}. Share the spreadsheet with ${sa.client_email} as Editor.`,
      );
    }
    throw new SheetsError(`Google Sheets error ${res.status}: ${msg}`);
  };
  return { request, email: sa.client_email };
}

export type SheetMode = "append" | "new-tab" | "new-file";

export interface SheetExportOptions {
  request: GoogleRequest;
  mode: SheetMode;
  /** Required for append and new-tab. */
  spreadsheetId?: string;
  /** Tab title (new-tab), file title (new-file), or tab to append to (append; default "Scrapers"). */
  title: string;
  /** Email to share a new file with (new-file only). */
  shareWith?: string;
}

export interface SheetExportResult {
  spreadsheetId: string;
  url: string;
  tab: string;
  written: number;
  skippedDuplicates: number;
}

const HEADER = COLUMNS.map((c) => c.header);
const tabTitle = (t: string) => t.replace(/[[\]*?/\\:]/g, " ").slice(0, 100);
const range = (tab: string, a1: string) => encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${a1}`);

async function writeValues(req: GoogleRequest, id: string, tab: string, values: unknown[][]) {
  // RAW: cell text is stored as-is, so bio text such as "=..." is never run as a formula.
  await req({
    method: "PUT",
    url: `${SHEETS}/${id}/values/${range(tab, "A1")}?valueInputOption=RAW`,
    data: { values },
  });
}

async function addTab(req: GoogleRequest, id: string, tab: string) {
  await req({
    method: "POST",
    url: `${SHEETS}/${id}:batchUpdate`,
    data: {
      requests: [
        {
          addSheet: {
            properties: { title: tab, rightToLeft: true, gridProperties: { frozenRowCount: 1 } },
          },
        },
      ],
    },
  });
}

/**
 * Writes leads to Google Sheets with the same columns as CSV/XLSX:
 * - append: adds rows to a tab of an existing spreadsheet, skipping usernames already there
 * - new-tab: adds a new right-to-left tab to an existing spreadsheet
 * - new-file: creates a spreadsheet owned by the service account and shares it
 */
export async function exportToSheet(
  rows: readonly LeadRow[],
  opts: SheetExportOptions,
): Promise<SheetExportResult> {
  const req = opts.request;
  const matrix = toMatrix(rows, { escapeFormulas: false });

  if (opts.mode === "new-file") {
    const tab = "العملاء";
    const created = await req<{ spreadsheetId: string; spreadsheetUrl: string }>({
      method: "POST",
      url: SHEETS,
      data: {
        properties: { title: opts.title, locale: "ar" },
        sheets: [
          { properties: { title: tab, rightToLeft: true, gridProperties: { frozenRowCount: 1 } } },
        ],
      },
    });
    await writeValues(req, created.spreadsheetId, tab, [HEADER, ...matrix]);
    if (opts.shareWith) {
      await req({
        method: "POST",
        url: `${DRIVE}/${created.spreadsheetId}/permissions?sendNotificationEmail=false`,
        data: { type: "user", role: "writer", emailAddress: opts.shareWith },
      });
    }
    return {
      spreadsheetId: created.spreadsheetId,
      url: created.spreadsheetUrl,
      tab,
      written: rows.length,
      skippedDuplicates: 0,
    };
  }

  const id = opts.spreadsheetId;
  if (!id)
    throw new SheetsError(
      `Mode "${opts.mode}" needs a spreadsheet id (set it on the project or pass one)`,
    );
  const url = `https://docs.google.com/spreadsheets/d/${id}/edit`;

  if (opts.mode === "new-tab") {
    const tab = tabTitle(opts.title);
    await addTab(req, id, tab);
    await writeValues(req, id, tab, [HEADER, ...matrix]);
    return { spreadsheetId: id, url, tab, written: rows.length, skippedDuplicates: 0 };
  }

  // append
  const tab = tabTitle(opts.title || "Scrapers");
  const meta = await req<{ sheets?: { properties?: { title?: string } }[] }>({
    method: "GET",
    url: `${SHEETS}/${id}?fields=sheets.properties.title`,
  });
  const exists = meta.sheets?.some((s) => s.properties?.title === tab);
  if (!exists) await addTab(req, id, tab);
  const current = exists
    ? await req<{ values?: string[][] }>({
        method: "GET",
        url: `${SHEETS}/${id}/values/${range(tab, "A:A")}`,
      })
    : { values: [] };
  const seen = new Set((current.values ?? []).map((r) => (r[0] ?? "").toLowerCase()));
  const fresh = matrix.filter((r) => !seen.has(String(r[0]).toLowerCase()));
  const values = seen.size === 0 ? [HEADER, ...fresh] : fresh;
  if (values.length > 0) {
    await req({
      method: "POST",
      url: `${SHEETS}/${id}/values/${range(tab, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      data: { values },
    });
  }
  return {
    spreadsheetId: id,
    url,
    tab,
    written: fresh.length,
    skippedDuplicates: matrix.length - fresh.length,
  };
}
