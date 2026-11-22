import { describe, expect, it } from "vitest";
import {
  dashboardPasswordProblem,
  isAllowedRedirect,
  MIN_PASSWORD_LENGTH,
  pkceChallenge,
  safeEqual,
  safeNext,
  sign,
  verify,
} from "../lib/tokens";

const secret = new TextEncoder().encode("x".repeat(40));
const other = new TextEncoder().encode("y".repeat(40));

describe("signed tokens", () => {
  it("round-trips claims and checks the token type", async () => {
    const t = await sign(secret, "code", { cid: "abc" }, 60);
    expect(await verify(secret, "code", t)).toMatchObject({ cid: "abc", typ: "code" });
    expect(await verify(secret, "access", t)).toBeNull();
  });

  it("rejects other secrets, expired and garbage tokens", async () => {
    const t = await sign(secret, "access", {}, 60);
    expect(await verify(other, "access", t)).toBeNull();
    expect(await verify(secret, "access", await sign(secret, "access", {}, -10))).toBeNull();
    expect(await verify(secret, "access", "not.a.jwt")).toBeNull();
  });
});

describe("helpers", () => {
  it("computes the RFC 7636 S256 example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("compares strings safely", () => {
    expect(safeEqual("password-123", "password-123")).toBe(true);
    expect(safeEqual("password-123", "password-124")).toBe(false);
    expect(safeEqual("a", "ab")).toBe(false);
  });

  it("allows only https or localhost redirects", () => {
    expect(isAllowedRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirect("http://localhost:6274/cb")).toBe(true);
    expect(isAllowedRedirect("http://evil.com/cb")).toBe(false);
    expect(isAllowedRedirect("https://x.com/cb#frag")).toBe(false);
    expect(isAllowedRedirect("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirect("nope")).toBe(false);
  });
});

describe("safeNext", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/leads?status=new")).toBe("/leads?status=new");
    expect(safeNext("/")).toBe("/");
  });

  it("refuses anything a browser could read as another site", () => {
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "https://evil.com",
      "evil",
      "/\tx",
      "",
    ]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});

describe("dashboardPasswordProblem", () => {
  it("accepts 8 characters or more", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(dashboardPasswordProblem("12345678")).toBeNull();
    expect(dashboardPasswordProblem("a-much-longer-password")).toBeNull();
  });

  it("explains in Arabic when the setting is missing or too short", () => {
    expect(dashboardPasswordProblem(undefined)).toMatch(/غير مضبوطة/);
    expect(dashboardPasswordProblem("")).toMatch(/غير مضبوطة/);
    expect(dashboardPasswordProblem("1234567")).toMatch(/أقصر من 8/);
  });
});
