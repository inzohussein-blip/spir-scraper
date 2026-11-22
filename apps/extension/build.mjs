// Builds the unpacked extension into dist/ (load it from chrome://extensions → Load unpacked).
// --e2e also grants <all_urls> so the browser test can drive local pages without prompts.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = `${root}dist`;
const e2e = process.argv.includes("--e2e");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: {
    background: `${root}src/background.ts`,
    sidepanel: `${root}src/sidepanel.ts`,
    content: `${root}src/page/content.ts`,
  },
  outdir: out,
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: !e2e,
  legalComments: "none",
  logLevel: "warning",
});
// The content script is injected as a classic script: rebuild it as an IIFE.
await build({
  entryPoints: [`${root}src/page/content.ts`],
  outfile: `${out}/content.js`,
  bundle: true,
  format: "iife",
  target: "chrome116",
  minify: !e2e,
  logLevel: "warning",
});
await cp(`${root}static`, out, { recursive: true });
if (e2e) {
  const manifest = JSON.parse(await readFile(`${out}/manifest.json`, "utf8"));
  manifest.host_permissions.push("<all_urls>");
  await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
}
console.log(`extension built in ${out}${e2e ? " (e2e)" : ""}`);
