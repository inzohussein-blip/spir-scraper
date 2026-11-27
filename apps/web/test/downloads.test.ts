import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..", "..");

describe("downloadable home programs", () => {
  it("serve exactly the programs in services/ig-worker", () => {
    for (const [download, source] of [
      ["spir-worker.py", "spir_worker.py"],
      ["rae-bridge.py", "rae_bridge.py"],
    ]) {
      expect(
        readFileSync(join(root, "apps/web/public/downloads", download as string), "utf8"),
        `${download} is out of date: copy services/ig-worker/${source} over it`,
      ).toBe(readFileSync(join(root, "services/ig-worker", source as string), "utf8"));
    }
  });
});
