import {
  BlockedError,
  NotFoundError,
  ProviderError,
  type ProviderId,
  RateLimitedError,
} from "@scrapers/core";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Maps HTTP failures onto the router's error types. */
export async function ensureOk(
  res: Response,
  provider: ProviderId,
  what: string,
): Promise<Response> {
  if (res.ok) return res;
  const body = (await res.text().catch(() => "")).slice(0, 200);
  const msg = `${what}: HTTP ${res.status}${body ? ` ${body}` : ""}`;
  if (res.status === 404) throw new NotFoundError(msg, provider);
  if (res.status === 429) throw new RateLimitedError(msg, provider);
  if (res.status === 401 || res.status === 403) throw new BlockedError(msg, provider);
  throw new ProviderError(msg, provider);
}
