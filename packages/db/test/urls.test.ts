import { describe, expect, it } from "vitest";
import { skipReason } from "../src/migrate.js";
import { databaseRegion, databaseUrl, directDatabaseUrl } from "../src/urls.js";

describe("connection urls", () => {
  it("prefers our own names", () => {
    const env = {
      DATABASE_URL: "pooled",
      DIRECT_DATABASE_URL: "direct",
      DATABASE_URL_UNPOOLED: "neon",
    };
    expect(databaseUrl(env)).toBe("pooled");
    expect(directDatabaseUrl(env)).toBe("direct");
  });

  it("accepts what Vercel's Neon integration sets", () => {
    const env = { DATABASE_URL: "pooled", DATABASE_URL_UNPOOLED: "neon-direct" };
    expect(directDatabaseUrl(env)).toBe("neon-direct");
  });

  it("accepts what Vercel's Supabase integration sets", () => {
    const env = { POSTGRES_URL: "pooled", POSTGRES_URL_NON_POOLING: "session" };
    expect(databaseUrl(env)).toBe("pooled");
    expect(directDatabaseUrl(env)).toBe("session");
  });

  it("accepts names Vercel's integrations set with a custom prefix", () => {
    const neon = { NEON_DATABASE_URL: "pooled", NEON_DATABASE_URL_UNPOOLED: "direct" };
    expect(databaseUrl(neon)).toBe("pooled");
    expect(directDatabaseUrl(neon)).toBe("direct");
    expect(databaseUrl({ NEON_POSTGRES_URL: "pg" })).toBe("pg");
    const custom = {
      DATABASE_ENV_PREFIX: "MYDB_",
      MYDB_DATABASE_URL: "mine",
      NEON_DATABASE_URL: "neon",
    };
    expect(databaseUrl(custom)).toBe("mine");
    // Unprefixed names still win.
    expect(databaseUrl({ DATABASE_URL: "own", NEON_DATABASE_URL: "neon" })).toBe("own");
  });

  it("falls back to the pooled url and ignores blanks", () => {
    expect(directDatabaseUrl({ DATABASE_URL: "pooled", DIRECT_DATABASE_URL: " " })).toBe("pooled");
    expect(directDatabaseUrl({})).toBeUndefined();
  });
});

describe("migrations on the Vercel build", () => {
  const url = { NEON_DATABASE_URL_UNPOOLED: "postgres://x" };
  it("runs on production builds with a database", () => {
    expect(skipReason(["--if-configured"], { ...url, VERCEL_ENV: "production" })).toBeNull();
  });
  it("skips without a database or on previews", () => {
    expect(skipReason(["--if-configured"], { VERCEL_ENV: "production" })).toMatch(/no database/);
    expect(skipReason(["--if-configured"], { ...url, VERCEL_ENV: "preview" })).toMatch(/preview/);
  });
  it("never skips when run by hand", () => {
    expect(skipReason([], {})).toBeNull();
  });
});

describe("databaseRegion", () => {
  it("reads Neon's region and the Vercel region next to it", () => {
    expect(
      databaseRegion(
        "postgres://u:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/db?sslmode=require",
      ),
    ).toEqual({
      host: "ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech",
      region: "eu-central-1",
      vercelRegion: "fra1",
    });
    expect(databaseRegion("postgres://u:p@ep-x.us-east-1.aws.neon.tech/db").vercelRegion).toBe(
      "iad1",
    );
    // Newer Neon hosts carry a cell label before the region.
    expect(databaseRegion("postgres://u:p@ep-x-pooler.c-2.us-east-1.aws.neon.tech/db").region).toBe(
      "us-east-1",
    );
  });

  it("returns nulls for other hosts and bad input", () => {
    expect(databaseRegion("postgres://localhost:5432/db")).toEqual({
      host: "localhost",
      region: null,
      vercelRegion: null,
    });
    expect(databaseRegion(undefined).host).toBeNull();
    expect(databaseRegion("not a url").host).toBeNull();
  });
});
