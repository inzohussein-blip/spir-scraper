import { describe, expect, it } from "vitest";
import { fromEntries, lookup, needsRefresh, withSaved } from "../src/lead-index.js";
import { Platform } from "../src/platform.js";

describe("the badge's local lead list", () => {
  it("answers from the list and downloads it at most once a day", () => {
    const now = Date.parse("2030-01-01T12:00:00Z");
    const idx = fromEntries(
      "p1",
      [
        ["Coach", "interested", 80],
        ["fx", "new", null],
      ],
      now,
    );
    expect(lookup(idx, "@coach")).toEqual({ status: "interested", aiScore: 80 });
    expect(lookup(idx, "stranger")).toBeNull();
    expect(needsRefresh(idx, "p1", now + 3600_000)).toBe(false);
    expect(needsRefresh(idx, "p1", now + 25 * 3600_000)).toBe(true);
    expect(needsRefresh(idx, "p2", now)).toBe(true);
    expect(needsRefresh(null, "p1", now)).toBe(true);
    expect(lookup(withSaved(idx, "@New_One"), "new_one")).toEqual({ status: "new", aiScore: null });
    expect(withSaved(idx, "coach")).toBe(idx);
  });

  it("downloads the list in one request", async () => {
    const urls: string[] = [];
    const p = new Platform("https://x.app", "k", async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ entries: [["a", "new", 10]], at: "now" }), {
        status: 200,
      });
    });
    expect(await p.leadIndex("p1")).toEqual([["a", "new", 10]]);
    expect(urls).toEqual(["https://x.app/api/v1/projects/p1/lead-index"]);
  });
});
