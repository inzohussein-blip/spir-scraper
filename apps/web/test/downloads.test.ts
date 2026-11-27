import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const web = join(__dirname, "..");
const root = join(web, "..", "..");

describe("downloadable home programs", () => {
  it("the build copies exactly the programs in services/ig-worker", () => {
    // The same step the build runs (public/downloads is not committed).
    execFileSync(process.execPath, [join(web, "scripts/copy-worker.mjs")], { stdio: "ignore" });
    for (const [download, source] of [
      ["spir-worker.py", "spir_worker.py"],
      ["rae-bridge.py", "rae_bridge.py"],
    ] as const) {
      expect(readFileSync(join(web, "public/downloads", download), "utf8")).toBe(
        readFileSync(join(root, "services/ig-worker", source), "utf8"),
      );
    }
  });
});
