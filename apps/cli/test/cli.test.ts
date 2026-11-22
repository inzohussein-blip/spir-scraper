import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@scrapers/core";
import { createTestRuntime, fakeWorker, type TestRuntime } from "@scrapers/runtime/testing";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProgram, type Io } from "../src/program.js";

const paidDiscovery: Provider = {
  id: "apify",
  capabilities: new Set(["hashtag_posters"]),
  ratePerMinute: 1000,
  costPer1k: 3,
  getProfile: async () => {
    throw new Error("unused");
  },
  async *listEngagers() {
    yield "user2";
  },
};

let rt: TestRuntime;
const dir = mkdtempSync(join(tmpdir(), "scrapers-cli-"));

beforeAll(async () => {
  rt = await createTestRuntime({ providers: [fakeWorker, paidDiscovery] });
});

afterAll(async () => {
  await rt.close();
});

async function cli(args: string[], answer = false) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    confirm: async () => answer,
  };
  // Commands close their context; the test keeps one database for all of them.
  const program = buildProgram(async () => ({ ...rt, close: async () => {} }), io).exitOverride();
  await program.parseAsync(["node", "scrapers", ...args]);
  // CI terminals enable colours; strip them so assertions and parsed ids see plain text.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const plain = (lines: string[]) => lines.join("\n").replace(ansi, "");
  return { out: plain(out), err: plain(err) };
}
describe("scrapers CLI", () => {
  it("creates and lists projects", async () => {
    expect((await cli(["project", "create", "gulf", "--retention", "30"])).out).toMatch(
      /project gulf .* 30 days/,
    );
    expect((await cli(["project", "list"])).out).toMatch(/gulf\s+30d/);
  });

  it("runs 500 uploaded accounts to an XLSX file (phase 1 gate)", async () => {
    const csv = join(dir, "accounts.csv");
    writeFileSync(
      csv,
      `username\n${Array.from({ length: 500 }, (_, i) => `@user${i + 1}`).join("\n")}\n`,
    );
    const out = join(dir, "leads.xlsx");
    const started = Date.now();
    const r = await cli([
      "run",
      csv,
      "-p",
      "gulf",
      "-l",
      "500",
      "-f",
      "xlsx",
      "-o",
      out,
      "--poll",
      "0.5",
    ]);
    expect(Date.now() - started).toBeLessThan(15 * 60_000);
    expect(r.out).toMatch(/done 100%/);
    expect(r.out).toMatch(/discovered 500 · enriched 500 · with contact 250/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(out) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("gulf");
    expect(ws?.rowCount).toBe(501);
    expect(ws?.views[0]).toMatchObject({ rightToLeft: true });
    const phones = (ws?.getColumn(6).values ?? []).filter(
      (v) => typeof v === "string" && v.startsWith("+964"),
    );
    expect(phones).toHaveLength(250);
  });

  it("lists and filters leads, as a table or JSON", async () => {
    const table = (await cli(["leads", "-p", "gulf", "--has-phone", "-n", "3"])).out;
    expect(table.split("\n")).toHaveLength(4);
    expect(table).toMatch(/@user500\s+1500\s+hi@shop500\.com\s+\+9647701000500/);
    const json = JSON.parse(
      (await cli(["leads", "-p", "gulf", "--business", "-n", "1000", "--json"])).out,
    );
    expect(json).toHaveLength(250);
  });

  it("exports CSV", async () => {
    const out = join(dir, "leads.csv");
    expect(
      (await cli(["export", "-p", "gulf", "-f", "csv", "-o", out, "--has-phone"])).out,
    ).toMatch(/250 leads/);
    expect(readFileSync(out, "utf8").startsWith("﻿")).toBe(true);
  });

  it("asks before spending money and starts when accepted", async () => {
    expect((await cli(["job", "start", "#forex", "-p", "gulf", "-l", "10"], false)).out).toMatch(
      /≈ \$0\.03\. Continue\?|Cancelled/,
    );
    const accepted = await cli(["job", "start", "#forex", "-p", "gulf", "-l", "10"], true);
    const id = /job (\S+) queued/.exec(accepted.out)?.[1];
    expect(id).toBeDefined();
    expect((await cli(["job", "status", id as string])).out).toMatch(
      /hashtag https:\/\/www\.instagram\.com\/explore\/tags\/forex\//,
    );
    expect((await cli(["job", "cancel", id as string])).out).toMatch(/cancelled/);
  });

  it("suppresses people and deletes their leads", async () => {
    await cli(["suppress", "--phone", "+9647701000500", "--username", "user498"]);
    const json = JSON.parse(
      (await cli(["leads", "-p", "gulf", "--has-phone", "-n", "1000", "--json"])).out,
    );
    expect(json).toHaveLength(248);
  });

  it("reports bad input", async () => {
    await expect(cli(["leads", "-p", "nope"])).rejects.toThrow(/Project not found/);
    await expect(cli(["job", "start", "https://evil.com/x", "-p", "gulf"])).rejects.toThrow(
      /instagram\.com/,
    );
    await expect(cli(["suppress"])).rejects.toThrow(/--username/);
    await expect(cli(["job", "start", "x", "-p", "gulf", "-l", "abc"])).rejects.toThrow();
  });

  it("manages API keys", async () => {
    const created = (await cli(["keys", "create", "n8n", "-s", "read,write"])).out;
    const key = /(sk_\S+)/.exec(created)?.[1] as string;
    expect(await rt.scrapers.verifyApiKey(key)).toMatchObject({ scopes: ["read", "write"] });
    const list = (await cli(["keys", "list"])).out;
    expect(list).toMatch(/n8n\s+\[read,write\]/);
    const id = list.split(/\s+/)[0] as string;
    await cli(["keys", "revoke", id]);
    expect(await rt.scrapers.verifyApiKey(key)).toBeNull();
  });

  it("explains missing AI and Sheets configuration", async () => {
    await expect(
      cli(["score", "00000000-0000-0000-0000-000000000000", "-c", "agents"]),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(cli(["export", "-p", "gulf", "-f", "sheet"])).rejects.toThrow(
      /GOOGLE_SERVICE_ACCOUNT_JSON/,
    );
    const report = (await cli(["report", "00000000-0000-0000-0000-000000000000"])).out;
    expect(JSON.parse(report)).toMatchObject({ total: 0 });
  });

  it("sets lead status, filters by it and searches", async () => {
    expect(
      (await cli(["lead", "status", "@user496", "interested", "-p", "gulf", "--note", "call back"]))
        .out,
    ).toContain("user496 → interested");
    await expect(cli(["lead", "status", "user496", "maybe", "-p", "gulf"])).rejects.toThrow(
      /status must be one of/,
    );
    await expect(cli(["lead", "status", "ghost", "contacted", "-p", "gulf"])).rejects.toThrow(
      /not a lead/,
    );
    const json = JSON.parse(
      (await cli(["leads", "-p", "gulf", "--status", "interested", "--json"])).out,
    );
    expect(json).toEqual([
      expect.objectContaining({
        username: "user496",
        status: "interested",
        statusNote: "call back",
      }),
    ]);
    expect(
      JSON.parse((await cli(["leads", "-p", "gulf", "-q", "user49", "--json"])).out).length,
    ).toBeGreaterThan(0);
  });

  it("changes project settings and manages monitors", async () => {
    expect(
      (await cli(["project", "set", "gulf", "--auto-export", "--keywords", "وكيل, IB"])).out,
    ).toContain("auto export on · keywords وكيل, IB");
    expect(
      (await cli(["project", "set", "gulf", "--no-auto-export", "--keywords", ""])).out,
    ).toContain("auto export off · keywords —");
    expect((await cli(["monitor", "add", "#forex", "-p", "gulf", "-e", "3"])).out).toContain(
      "every 3 days",
    );
    const list = (await cli(["monitor", "list", "-p", "gulf"])).out;
    expect(list).toMatch(/on +every 3d/);
    expect((await cli(["monitor", "run"])).out).toMatch(/started 1 job/);
    expect((await cli(["monitor", "run"])).out).toBe("No monitor is due.");
    await cli(["monitor", "rm", list.split(/\s+/)[0] as string]);
    expect((await cli(["monitor", "list"])).out).toBe("No monitors.");
  });

  it("generates VAPID keys and runs doctor", async () => {
    expect((await cli(["push-keys"])).out).toMatch(
      /VAPID_PUBLIC_KEY=\S{40,}\nVAPID_PRIVATE_KEY=\S{20,}/,
    );
    const doctor = (await cli(["doctor"])).out;
    expect(doctor).toContain("database reachable");
    expect(doctor).toContain("run with --live");
  });
});
