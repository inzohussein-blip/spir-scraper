import type { LeadRow } from "@scrapers/core";
import ExcelJS from "exceljs";
import { COLUMNS, toMatrix } from "./columns.js";

/** XLSX with a right-to-left sheet, frozen bold header, filters and score colours. */
export async function toXlsx(
  rows: readonly LeadRow[],
  opts: { sheetName?: string } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Scrapers";
  wb.created = new Date();
  const ws = wb.addWorksheet((opts.sheetName ?? "العملاء").slice(0, 31), {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
  });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.addRows(toMatrix(rows));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  header.alignment = { vertical: "middle", horizontal: "center" };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  const scoreCol = COLUMNS.findIndex((c) => c.key === "ai_score") + 1;
  if (rows.length > 0 && scoreCol > 0) {
    const letter = ws.getColumn(scoreCol).letter;
    ws.addConditionalFormatting({
      ref: `${letter}2:${letter}${rows.length + 1}`,
      rules: [
        {
          type: "colorScale",
          priority: 1,
          cfvo: [
            { type: "num", value: 0 },
            { type: "num", value: 50 },
            { type: "num", value: 100 },
          ],
          color: [{ argb: "FFF8696B" }, { argb: "FFFFEB84" }, { argb: "FF63BE7B" }],
        },
      ],
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
