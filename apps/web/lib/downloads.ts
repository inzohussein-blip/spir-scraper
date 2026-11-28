/**
 * The Windows .exe builds of the home programs, published by the
 * «Home programs» workflow to the repository's «home-programs» release.
 * They are an extra choice: the .py files under /downloads stay as they are.
 */
const REPO = "inzohussein-blip/spir-scraper";
const RELEASE = `https://github.com/${REPO}/releases/download/home-programs`;

export const EXE = {
  worker: `${RELEASE}/spir-worker.exe`,
  bridge: `${RELEASE}/rae-bridge.exe`,
  checksums: `${RELEASE}/SHA256SUMS.txt`,
  release: `https://github.com/${REPO}/releases/tag/home-programs`,
} as const;
