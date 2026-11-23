/**
 * Server errors reach the owner instead of hiding in the logs: one bell and
 * Telegram alert per page per hour (the same key within the window is not repeated).
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string },
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getRuntime } = await import("./lib/runtime");
    const rt = await getRuntime();
    const hour = new Date().toISOString().slice(0, 13);
    const message = err instanceof Error ? err.message : String(err);
    await rt.scrapers.notify({
      type: "system",
      level: "bad",
      title: `خطأ في الخادم: ${context.routePath}`,
      body: `${request.method} ${request.path.split("?")[0]}\n${message.slice(0, 500)}`,
      url: "/activity",
      key: `server-error:${context.routePath}:${hour}`,
    });
  } catch {
    // Reporting must never cause another failure.
  }
}
