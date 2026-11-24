// Copies the standalone home worker into public/downloads so the dashboard can offer it.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, "../../../services/ig-worker/spir_worker.py");
const to = resolve(here, "../public/downloads/spir-worker.py");
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log("copied spir-worker.py");
