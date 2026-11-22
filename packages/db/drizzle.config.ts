import { defineConfig } from "drizzle-kit";
import { directDatabaseUrl } from "./src/urls.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: directDatabaseUrl() ?? "",
  },
  strict: true,
});
