import { createApi } from "@scrapers/api";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";

const api = createApi(getRuntime);

export function GET(req: Request) {
  const url = new URL(req.url);
  url.pathname = "/openapi.json";
  return api.fetch(new Request(url, req));
}
