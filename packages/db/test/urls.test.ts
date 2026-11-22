import { describe, expect, it } from "vitest";
import { databaseUrl, directDatabaseUrl } from "../src/urls.js";

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
