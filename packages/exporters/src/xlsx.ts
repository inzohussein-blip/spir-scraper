import type { LeadRow } from "@scrapers/core";
import { strToU8, zipSync } from "fflate";
import { COLUMNS, toMatrix } from "./columns.js";

type Cell = string | number | null;

/** Characters XML 1.0 does not allow, even escaped (bios can contain them). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function xml(s: string): string {
  return s
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 1 → A, 27 → AA. */
export function columnLetter(n: number): string {
  let s = "";
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26))
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** Excel sheet names: at most 31 characters, none of []:*?/\ and not blank. */
export function sheetTitle(name: string): string {
  const clean = name
    .replace(/[[\]:*?/\\]/g, " ")
    .replace(INVALID_XML, "")
    .trim()
    .slice(0, 31);
  return clean || "Sheet1";
}

function cell(ref: string, v: Cell, style?: number): string {
  if (v === null || v === undefined) return "";
  const s = style ? ` s="${style}"` : "";
  if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
}

function row(index: number, values: readonly Cell[], style?: number): string {
  const cells = values.map((v, i) => cell(`${columnLetter(i + 1)}${index}`, v, style)).join("");
  return `<row r="${index}">${cells}</row>`;
}

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

const STYLES = `${HEAD}<styleSheet xmlns="${NS_MAIN}">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** XLSX with a right-to-left sheet, frozen bold header, filters and score colours. */
export async function toXlsx(
  rows: readonly LeadRow[],
  opts: { sheetName?: string } = {},
): Promise<Buffer> {
  const title = sheetTitle(opts.sheetName ?? "العملاء");
  const matrix = toMatrix(rows);
  const lastCol = columnLetter(COLUMNS.length);
  const lastRow = matrix.length + 1;
  const range = `A1:${lastCol}${lastRow}`;

  const cols = COLUMNS.map(
    (c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`,
  ).join("");
  const data = [
    row(
      1,
      COLUMNS.map((c) => c.header),
      1,
    ),
    ...matrix.map((values, i) => row(i + 2, values)),
  ].join("");

  const scoreCol = COLUMNS.findIndex((c) => c.key === "ai_score") + 1;
  let scale = "";
  if (matrix.length > 0 && scoreCol > 0) {
    const l = columnLetter(scoreCol);
    scale =
      `<conditionalFormatting sqref="${l}2:${l}${lastRow}"><cfRule type="colorScale" priority="1"><colorScale>` +
      '<cfvo type="num" val="0"/><cfvo type="num" val="50"/><cfvo type="num" val="100"/>' +
      '<color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/>' +
      "</colorScale></cfRule></conditionalFormatting>";
  }

  const sheet =
    `${HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<dimension ref="${range}"/>` +
    '<sheetViews><sheetView rightToLeft="1" workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${cols}</cols><sheetData>${data}</sheetData>` +
    `<autoFilter ref="A1:${lastCol}1"/>${scale}</worksheet>`;

  const quoted = `'${xml(title).replace(/'/g, "''")}'`;
  const workbook =
    `${HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<bookViews><workbookView/></bookViews><sheets><sheet name="${xml(title)}" sheetId="1" r:id="rId1"/></sheets>` +
    `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${quoted}!$A$1:$${lastCol}$1</definedName></definedNames>` +
    "</workbook>";

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const files: Record<string, string> = {
    "[Content_Types].xml":
      `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      "</Types>",
    "_rels/.rels":
      `${HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      "</Relationships>",
    "docProps/core.xml":
      `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:creator>Scrapers</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
      "</cp:coreProperties>",
    "xl/workbook.xml": workbook,
    "xl/_rels/workbook.xml.rels":
      `${HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>",
    "xl/styles.xml": STYLES,
    "xl/worksheets/sheet1.xml": sheet,
  };

  const zipped = zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
    { level: 6 },
  );
  return Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength);
}
