import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { directDatabaseUrl } from "./urls.js";

export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function main() {
  const url = directDatabaseUrl();
  if (!url) throw new Error("Set DIRECT_DATABASE_URL (or DATABASE_URL_UNPOOLED / DATABASE_URL)");
  const client = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
    console.log("migrations applied");
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
