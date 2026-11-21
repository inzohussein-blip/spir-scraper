import type { LeadRow } from "@scrapers/core";
import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  exportToSheet,
  type GoogleRequest,
  SheetsError,
  serviceAccountRequest,
} from "../src/index.js";

const row = (username: string, over: Partial<LeadRow> = {}): LeadRow => ({
  username,
  fullName: null,
  category: null,
  followers: 10,
  isBusiness: true,
  email: null,
  phone: null,
  phoneCountry: null,
  phoneConfirmed: false,
  contactSource: null,
  aiScore: null,
  aiTags: null,
  aiReason: null,
  sourceUrl: "s",
  fetchedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

function fakeGoogle(responses: (url: string, method: string) => unknown = () => ({})) {
  const calls: { method: string; url: string; data?: any }[] = [];
  const request: GoogleRequest = async (o) => {
    calls.push(o);
    return responses(o.url, o.method) as never;
  };
  return { request, calls };
}

describe("exportToSheet", () => {
  it("creates a new RTL file, writes header and rows raw, and shares it", async () => {
    const g = fakeGoogle((url, method) =>
      method === "POST" && url.endsWith("/spreadsheets")
        ? { spreadsheetId: "S1", spreadsheetUrl: "https://x/S1" }
        : {},
    );
    const r = await exportToSheet([row("a", { fullName: "=HACK()" })], {
      request: g.request,
      mode: "new-file",
      title: "Scrapers – p",
      shareWith: "me@example.com",
    });
    expect(r).toMatchObject({ spreadsheetId: "S1", url: "https://x/S1", written: 1 });
    expect(g.calls[0]?.data.sheets[0].properties).toMatchObject({
      rightToLeft: true,
      gridProperties: { frozenRowCount: 1 },
    });
    expect(g.calls[1]?.url).toContain("valueInputOption=RAW");
    expect(g.calls[1]?.data.values[0]).toEqual(COLUMNS.map((c) => c.header));
    expect(g.calls[1]?.data.values[1][1]).toBe("=HACK()"); // RAW keeps it as text, no apostrophe
    expect(g.calls[2]).toMatchObject({
      url: expect.stringContaining("/S1/permissions"),
      data: { emailAddress: "me@example.com", role: "writer" },
    });
  });

  it("adds a new tab to an existing spreadsheet", async () => {
    const g = fakeGoogle();
    const r = await exportToSheet([row("a")], {
      request: g.request,
      mode: "new-tab",
      spreadsheetId: "S2",
      title: "job: 1/2",
    });
    expect(r).toMatchObject({
      tab: "job  1 2",
      url: "https://docs.google.com/spreadsheets/d/S2/edit",
    });
    expect(g.calls[0]?.data.requests[0].addSheet.properties.title).toBe("job  1 2");
  });

  it("appends only new usernames to an existing tab", async () => {
    const g = fakeGoogle((url, method) => {
      if (method === "GET" && url.includes("fields="))
        return { sheets: [{ properties: { title: "Scrapers" } }] };
      if (method === "GET") return { values: [["المعرّف"], ["A"]] };
      return {};
    });
    const r = await exportToSheet([row("a"), row("b")], {
      request: g.request,
      mode: "append",
      spreadsheetId: "S3",
      title: "Scrapers",
    });
    expect(r).toMatchObject({ written: 1, skippedDuplicates: 1 });
    const append = g.calls.at(-1);
    expect(append?.url).toContain(":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS");
    expect(append?.data.values.map((v: unknown[]) => v[0])).toEqual(["b"]);
  });

  it("creates the tab with a header when appending for the first time", async () => {
    const g = fakeGoogle((_url, method) => (method === "GET" ? { sheets: [] } : {}));
    await exportToSheet([row("a")], {
      request: g.request,
      mode: "append",
      spreadsheetId: "S4",
      title: "",
    });
    expect(g.calls[1]?.data.requests[0].addSheet.properties.title).toBe("Scrapers");
    expect(g.calls[2]?.data.values[0][0]).toBe("المعرّف");
  });

  it("skips the write when nothing is new and requires an id", async () => {
    const g = fakeGoogle((url, method) => {
      if (url.includes("fields=")) return { sheets: [{ properties: { title: "T" } }] };
      return method === "GET" ? { values: [["h"], ["a"]] } : {};
    });
    expect(
      await exportToSheet([row("a")], {
        request: g.request,
        mode: "append",
        spreadsheetId: "S",
        title: "T",
      }),
    ).toMatchObject({ written: 0 });
    expect(g.calls).toHaveLength(2);
    await expect(
      exportToSheet([], { request: g.request, mode: "append", title: "T" }),
    ).rejects.toBeInstanceOf(SheetsError);
  });
});

describe("serviceAccountRequest", () => {
  it("accepts raw or base64 JSON", () => {
    const json = JSON.stringify({ client_email: "sa@p.iam.gserviceaccount.com", private_key: "k" });
    expect(serviceAccountRequest(json).email).toBe("sa@p.iam.gserviceaccount.com");
    expect(serviceAccountRequest(Buffer.from(json).toString("base64")).email).toBe(
      "sa@p.iam.gserviceaccount.com",
    );
  });
});
