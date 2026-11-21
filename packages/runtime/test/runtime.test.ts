import { uploadSource } from "@scrapers/core";
import type { GoogleRequest } from "@scrapers/exporters";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import { createTestRuntime, settle } from "../src/testing.js";

describe("createRuntime", () => {
  it("requires its secrets", async () => {
    await expect(createRuntime({})).rejects.toThrow(/SUPPRESSION_PEPPER/);
    await expect(createRuntime({ SUPPRESSION_PEPPER: "x" })).rejects.toThrow(/DATABASE_URL/);
  });
});

describe("exportLeads", () => {
  it("exports CSV, XLSX and Google Sheets with sensible sheet defaults", async () => {
    const calls: { method: string; url: string }[] = [];
    const sheetsRequest: GoogleRequest = async (o) => {
      calls.push(o);
      if (o.method === "POST" && o.url.endsWith("/spreadsheets"))
        return { spreadsheetId: "NEW", spreadsheetUrl: "u" } as never;
      if (o.method === "GET" && o.url.includes("fields=")) return { sheets: [] } as never;
      return {} as never;
    };
    const rt = await createTestRuntime({ sheetsRequest });
    try {
      expect(rt.sheetsEmail).toBe("sa@test.iam");
      const p = await rt.scrapers.createProject({ name: "خليج", owner: rt.owner });
      await rt.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(["user1", "user2", "user4"]),
        limit: 10,
      });
      await settle(rt);

      const csv = await rt.exportLeads({
        projectId: p.id,
        format: "csv",
        filters: { hasPhone: true },
      });
      expect(csv).toMatchObject({ kind: "file", count: 2, contentType: "text/csv; charset=utf-8" });
      if (csv.kind === "file") expect(csv.filename).toMatch(/^scrapers-خليج-.*\.csv$/);

      const xlsx = await rt.exportLeads({ projectId: p.id, format: "xlsx" });
      const wb = new ExcelJS.Workbook();
      if (xlsx.kind === "file") await wb.xlsx.load(xlsx.data as unknown as ArrayBuffer);
      expect(wb.getWorksheet("خليج")?.rowCount).toBe(4);

      // No sheet on the project: a new file shared with the owner.
      expect(await rt.exportLeads({ projectId: p.id, format: "sheet" })).toMatchObject({
        kind: "sheet",
        spreadsheetId: "NEW",
        count: 3,
      });
      expect(calls.some((c) => c.url.includes("/NEW/permissions"))).toBe(true);

      // With a sheet on the project: append.
      const withSheet = await rt.scrapers.createProject({
        name: "b",
        owner: rt.owner,
        sheetId: "EXIST",
      });
      expect(await rt.exportLeads({ projectId: withSheet.id, format: "sheet" })).toMatchObject({
        spreadsheetId: "EXIST",
        tab: "Scrapers",
      });

      await expect(
        rt.exportLeads({ projectId: "00000000-0000-0000-0000-000000000000", format: "csv" }),
      ).rejects.toThrow(/not found/);
    } finally {
      await rt.close();
    }
  });

  it("explains when Sheets is not configured", async () => {
    const rt = await createTestRuntime();
    try {
      const p = await rt.scrapers.createProject({ name: "p", owner: rt.owner });
      await expect(rt.exportLeads({ projectId: p.id, format: "sheet" })).rejects.toThrow(
        /GOOGLE_SERVICE_ACCOUNT_JSON/,
      );
    } finally {
      await rt.close();
    }
  });
});
