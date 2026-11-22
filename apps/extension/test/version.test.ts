import { describe, expect, it } from "vitest";
import { compareVersions } from "../src/version.js";

describe("compareVersions", () => {
  it("compares build versions numerically", () => {
    expect(compareVersions("1.26327.905", "1.26326.2148")).toBe(1);
    expect(compareVersions("1.26326.2148", "1.26326.2148")).toBe(0);
    expect(compareVersions("0.1.0", "1.26326.1")).toBe(-1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });
});
