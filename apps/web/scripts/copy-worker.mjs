// Copies the home programs into public/downloads so the dashboard can offer them:
// the standalone home worker and the local bridge of the reverse-api-engineer window.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = [
  ["spir_worker.py", "spir-worker.py"],
  ["rae_bridge.py", "rae-bridge.py"],
];
for (const [source, download] of files) {
  const to = resolve(here, "../public/downloads", download);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(resolve(here, "../../../services/ig-worker", source), to);
  console.log(`copied ${download}`);
}
