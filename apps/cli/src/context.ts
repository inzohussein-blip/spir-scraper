import { createRuntime, type Runtime } from "@scrapers/runtime";

export type Context = Runtime;
export type ContextFactory = () => Promise<Context>;

/** Loads .env from the current directory if it exists (Node's built-in loader). */
export function loadEnv() {
  try {
    process.loadEnvFile();
  } catch {
    // No .env: rely on the real environment.
  }
}

export const productionContext: ContextFactory = () => createRuntime(process.env);
