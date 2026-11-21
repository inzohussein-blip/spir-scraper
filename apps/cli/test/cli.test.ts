import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createScrapers, type Provider, ProviderRouter, type RawProfile } from "@scrapers/core";
import * as schema from "@scrapers/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import ExcelJS from "exceljs";
import { fromPglite, PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../src/context.js";
import { buildProgram, type Io } from "../src/program.js";

const migrationsFolder = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

function profile(username: string): RawProfile {
  const n = Number(username.replace(/\D/g, "")) || 0;
  return {
    igUserId: `id-${n}`,
    username,
    isBusiness: n % 2 === 0,
    isVerified: false,
    followers: 1000 + n,
    bio: n % 2 === 0 ? `🇮🇶 واتساب ٠٧٧٠${String(1000000 + n).slice(-7)}` : "personal",
  };
}

const fakeWorker: Provider = {
  id: "worker",
  capabilities: new Set(["profile"]),
  ratePerMinute: 1_000_000,
  costPer1k: 0,
  getProfile: async (u) => profile(u),
};
const paidDiscovery: Provider = {
  id: "apify",
  capabilities: new Set(["hashtag_posters"]),
  ratePerMinute: 1000,
  costPer1k: 3,
  getProfile: async (u) => profile(u),
  async *listEngagers() {
    yield "user2";
  },
};

let pg: PGlite;
let boss: PgBoss;
let ctx: Context;
const dir = mkdtempSync(join(tmpdir(), "scrapers-cli-"));

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder });
  boss = new PgBoss({ db: fromPglite(pg), backend: "pglite", supervise: false, schedule: false });
  boss.on("error", () => {});
  await boss.start();
  const scrapers = createScrapers({
    db,
    boss,
    router: new ProviderRouter([fakeWorker, paidDiscovery], { sleep: async () => {} }),
    config: { suppressionPepper: "p" },
  });
  await scrapers.init();
  // Commands close their context; the test keeps one database for all of them.
  ctx = { scrapers, owner: "me@example.com", close: async () => {} };
});

afterAll(async () => {
  await boss.stop({ graceful: false, timeout: 1000 }).catch(() => {});
  await pg.close();
});

async function cli(args: string[], answer = false) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    confirm: async () => answer,
  };
  const program = buildProgram(async () => ctx, io).exitOverride();
  await program.parseAsync(["node", "scrapers", ...args]);
  return { out: out.join("\n"), err: err.join("\n") };
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
    const ws = wb.getWorksheet("العملاء");
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
    expect(table).toMatch(/@user500\s+1500\s+\+9647701000500/);
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
});
