#!/usr/bin/env node
import { loadEnv, productionContext } from "./context.js";
import { buildProgram } from "./program.js";

loadEnv();
const program = buildProgram(productionContext);
try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await program.close().catch(() => {});
}
