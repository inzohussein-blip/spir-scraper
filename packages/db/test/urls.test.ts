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

  it("falls back to the pooled url and ignores blanks", () => {
    expect(directDatabaseUrl({ DATABASE_URL: "pooled", DIRECT_DATABASE_URL: " " })).toBe("pooled");
    expect(directDatabaseUrl({})).toBeUndefined();
  });
});
