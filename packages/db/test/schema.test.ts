import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const pg = new PGlite({ extensions: { pg_trgm } });
const db = drizzle(pg, { schema });

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000);

/** Drizzle wraps driver errors; the constraint name lives on the cause. */
function first<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("expected a row");
  return row;
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} ${err.cause?.message ?? ""}`;
  }
  throw new Error("expected the query to be rejected");
}

let projectId: string;
let jobId: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder });
  const project = first(
    await db
      .insert(schema.projects)
      .values({ name: "test", owner: "owner@example.com" })
      .returning(),
  );
  projectId = project.id;
  const job = first(
    await db
      .insert(schema.jobs)
      .values({
        projectId,
        sourceType: "profile",
        sourceUrl: "https://instagram.com/x",
        limit: 10,
      })
      .returning(),
  );
  jobId = job.id;
  await db.insert(schema.profiles).values([
    { igUserId: "1", username: "biz", isBusiness: true, fetchedBy: "worker" },
    { igUserId: "2", username: "person", fetchedBy: "worker" },
  ]);
});

afterAll(async () => {
  await pg.close();
});

describe("migrations", () => {
  it("create every table with RLS enabled", async () => {
    const { rows } = await pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([
      "api_keys",
      "audit_log",
      "competitor_snapshots",
      "counters",
      "ephemeral",
      "jobs",
      "lead_events",
      "leads",
      "monitors",
      "notifications",
      "profile_snapshots",
      "profiles",
      "projects",
      "push_subscriptions",
      "suppression",
    ]);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it("apply defaults", async () => {
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(p?.retentionDays).toBe(90);
    const [j] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(j?.status).toBe("queued");
    expect(j?.counts).toEqual({});
  });
});

describe("constraints", () => {
  it("reject a job limit outside 1..5000", async () => {
    const msg = await rejection(
      db.insert(schema.jobs).values({
        projectId,
        sourceType: "hashtag",
        sourceUrl: "https://instagram.com/explore/tags/x",
        limit: 5001,
      }),
    );
    expect(msg).toMatch(/jobs_limit_range/);
  });

  it("require a contact source whenever contact data is stored", async () => {
    const msg = await rejection(
      db.insert(schema.leads).values({
        projectId,
        jobId,
        profileId: "1",
        email: "a@b.com",
        expiresAt: inDays(90),
      }),
    );
    expect(msg).toMatch(/leads_contact_has_source/);
  });

  it("accept a lead without contact data (personal account)", async () => {
    await db
      .insert(schema.leads)
      .values({ projectId, jobId, profileId: "2", expiresAt: inDays(90) });
  });

  it("keep one lead per profile per project", async () => {
    await db.insert(schema.leads).values({
      projectId,
      jobId,
      profileId: "1",
      email: "a@b.com",
      contactSource: "business_button",
      expiresAt: inDays(90),
    });
    const msg = await rejection(
      db.insert(schema.leads).values({ projectId, jobId, profileId: "1", expiresAt: inDays(90) }),
    );
    expect(msg).toMatch(/leads_project_profile_uq/);
  });

  it("reject an ai_score above 100", async () => {
    const msg = await rejection(
      db.update(schema.leads).set({ aiScore: 101 }).where(eq(schema.leads.profileId, "1")),
    );
    expect(msg).toMatch(/leads_ai_score_range/);
  });

  it("only accept known suppression kinds", async () => {
    const msg = await rejection(
      db.insert(schema.suppression).values({ valueHash: "h", kind: "address" }),
    );
    expect(msg).toMatch(/suppression_kind/);
  });

  it("cascade deletes from a project to its jobs and leads", async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
    const [{ n }] = (
      await db.execute<{ n: number }>(
        sql`select (select count(*) from jobs) + (select count(*) from leads) as n`,
      )
    ).rows as [{ n: number }];
    expect(Number(n)).toBe(0);
  });
});
