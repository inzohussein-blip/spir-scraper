// Builds the unpacked extension into dist/ (load it from chrome://extensions → Load unpacked).
// --e2e also grants <all_urls> so the browser test can drive local pages without prompts.
// --zip <file> also writes a zip of dist/ and <file without .zip>.json ({ version, builtAt, bytes })
// for the dashboard's download page.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = `${root}dist`;
const e2e = process.argv.includes("--e2e");
const zipArg = process.argv.indexOf("--zip");
const zipPath = zipArg > 0 ? process.argv[zipArg + 1] : undefined;

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

async function filesIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return nested.flat();
}

if (zipPath) {
  const files = {};
  for (const f of await filesIn(out)) files[relative(out, f)] = new Uint8Array(await readFile(f));
  const zip = zipSync(files, { level: 9 });
  await mkdir(dirname(zipPath), { recursive: true });
  await writeFile(zipPath, zip);
  const { version } = JSON.parse(await readFile(`${out}/manifest.json`, "utf8"));
  const meta = { version, builtAt: new Date().toISOString(), bytes: (await stat(zipPath)).size };
  await writeFile(zipPath.replace(/\.zip$/, ".json"), JSON.stringify(meta));
  console.log(`zip written to ${zipPath} (${meta.bytes} bytes)`);
}
