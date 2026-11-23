import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchLike } from "../http.js";

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** True for loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true;
}

export interface SafeFetchOptions {
  fetch?: FetchLike;
  lookup?: Lookup;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/** Refuses anything but public http(s) hosts on the standard ports. */
export async function assertPublicUrl(raw: string, lookup: Lookup = defaultLookup): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("رابط غير صالح");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new UnsafeUrlError("الرابط يجب أن يبدأ بـ http أو https");
  if (u.username || u.password) throw new UnsafeUrlError("روابط فيها اسم مستخدم غير مسموحة");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UnsafeUrlError("منفذ غير مسموح");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host))
    throw new UnsafeUrlError("عنوان داخلي غير مسموح");
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address)))
    throw new UnsafeUrlError("عنوان داخلي غير مسموح");
  return u;
}

/**
 * Fetches a public web page for reading: checks every hop (redirects
 * included) resolves to a public address, stops at maxBytes and timeoutMs,
 * and only accepts text. It never sends cookies or credentials.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<FetchedPage> {
  const fetchFn: FetchLike = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const lookup = opts.lookup ?? defaultLookup;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  let url = raw;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const u = await assertPublicUrl(url, lookup);
    const res = await fetchFn(u.toString(), {
      redirect: "manual",
      headers: {
        "user-agent": opts.userAgent ?? "Mozilla/5.0 (compatible; SiteReader/1.0)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
        "accept-language": "ar,en;q=0.8",
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location") as string, u).toString();
      continue;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/|xhtml|xml/i.test(contentType) && contentType)
      throw new UnsafeUrlError(`ليست صفحة نصية (${contentType.split(";")[0]})`);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const body = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    return { url: u.toString(), status: res.status, contentType, body };
  }
  throw new UnsafeUrlError("تحويلات كثيرة");
}

/** Whether robots.txt lets any user agent (*) read a path. Missing or unreadable: allowed. */
export function robotsAllows(robots: string, path: string): boolean {
  let applies = false;
  let anyGroup = false;
  const rules: { allow: boolean; prefix: string }[] = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = (m[1] as string).toLowerCase();
    const value = (m[2] as string).trim();
    if (key === "user-agent") {
      if (rules.length > 0 && applies) break;
      applies = value === "*";
      anyGroup ||= applies;
    } else if (applies && (key === "disallow" || key === "allow") && value) {
      rules.push({ allow: key === "allow", prefix: value.replace(/\*$/, "") });
    }
  }
  if (!anyGroup) return true;
  // The longest matching rule wins; Allow wins ties.
  let best: { allow: boolean; prefix: string } | null = null;
  for (const r of rules) {
    if (!path.startsWith(r.prefix)) continue;
    if (
      !best ||
      r.prefix.length > best.prefix.length ||
      (r.prefix.length === best.prefix.length && r.allow)
    )
      best = r;
  }
  return best ? best.allow : true;
}
