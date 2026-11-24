import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  // Server modules guard against client bundles with "server-only"; tests run on the server.
  resolve: {
    alias: { "server-only": fileURLToPath(new URL("test/server-only.ts", import.meta.url)) },
  },
});
