import type { LeadRow } from "@scrapers/core";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { COLUMNS, safeCell, toCsv, toXlsx } from "../src/index.js";

const row = (over: Partial<LeadRow> = {}): LeadRow => ({
  username: "acme",
  fullName: "شركة أكمي",
  category: "Finance",
  followers: 1200,
  isBusiness: true,
  email: "a@acme.com",
  phone: "+966501234567",
  phoneCountry: "SA",
  phoneConfirmed: true,
  contactSource: "bio",
  aiScore: 80,
  aiTags: ["وكيل", "خليج"],
  aiReason: "يتحدث العربية",
  sourceUrl: "https://www.instagram.com/competitor/",
  fetchedAt: new Date("2026-11-21T10:00:00Z"),
  ...over,
});

describe("safeCell", () => {
  it("neutralises formulas but keeps phone numbers", () => {
    expect(safeCell('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")');
    expect(safeCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(safeCell("-1+1")).toBe("'-1+1");
    expect(safeCell("+966 50 123 4567")).toBe("+966 50 123 4567");
    expect(safeCell("+cmd")).toBe("'+cmd");
    expect(safeCell(5)).toBe(5);
    expect(safeCell(null)).toBeNull();
  });
});

describe("toCsv", () => {
  it("writes a BOM, Arabic headers and one line per lead", () => {
    const csv = toCsv([
      row(),
      row({ username: "b", phone: "0501234567", phoneConfirmed: false, aiTags: null }),
    ]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(COLUMNS.map((c) => c.header).join(","));
    expect(lines[1]).toContain("شركة أكمي");
    expect(lines[1]).toContain("وكيل، خليج");
    expect(lines[2]).toContain(",لا,");
  });

  it("can use machine-readable headers", () => {
    expect(toCsv([], { headers: "keys" }).slice(1).trim()).toBe(
      COLUMNS.map((c) => c.key).join(","),
    );
  });

  it("escapes injected formulas", () => {
    expect(toCsv([row({ fullName: "=cmd|' /C calc'!A0" })])).toContain("'=cmd");
  });
});

describe("toXlsx", () => {
  it("writes an RTL sheet with a frozen header and all rows", async () => {
    const buf = await toXlsx([row(), row({ username: "b", aiScore: null, phone: null })], {
      sheetName: "وكلاء",
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("وكلاء");
    expect(ws).toBeDefined();
    expect(ws?.views[0]).toMatchObject({ rightToLeft: true, state: "frozen", ySplit: 1 });
    expect(ws?.rowCount).toBe(3);
    expect(ws?.getRow(1).getCell(1).value).toBe("المعرّف");
    expect(ws?.getRow(2).getCell(5).value).toBe("a@acme.com");
    expect(ws?.getRow(3).getCell(8).value).toBeNull();
  });

  it("handles an empty export", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await toXlsx([])) as unknown as ArrayBuffer);
    expect(wb.getWorksheet("العملاء")?.rowCount).toBe(1);
  });
});
