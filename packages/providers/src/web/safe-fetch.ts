import { lookup as dnsLookupCb, type LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { FetchLike } from "../http.js";

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function privateV4(ip: string): boolean {
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

/** The eight 16-bit groups of an IPv6 address (any spelling, including a dotted IPv4 tail). */
function ipv6Groups(ip: string): number[] | null {
  let x = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split(".").map(Number);
    x = `${x.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = x.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * True for loopback, private, link-local, carrier-grade NAT, multicast and
 * reserved addresses, including IPv4 addresses carried inside IPv6
 * (::ffff:0:0/96 mapped, ::/96 compatible, 64:ff9b::/96 NAT64, 2002::/16 6to4)
 * whatever their spelling. Anything that cannot be parsed counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip.replace(/%.*$/, ""));
  if (v === 4) return privateV4(ip);
  if (v !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  // ::/96 (unspecified, loopback, deprecated IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return privateV4(v4Of(g6, g7));
    if (g5 === 0) return true;
  }
  // ::ffff:0:0:0/96 (IPv4-translated).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  // NAT64: the well-known prefix carries an IPv4 address; the local-use one is internal.
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 1 || privateV4(v4Of(g6, g7));
  // 6to4 carries an IPv4 address in its second and third groups.
  if (g0 === 0x2002) return privateV4(v4Of(g1, g2));
  // Teredo (2001::/32) hides the real address; documentation 2001:db8::/32; discard 100::/64.
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8.
  return (
    (g0 & 0xfe00) === 0xfc00 ||
    (g0 & 0xffc0) === 0xfe80 ||
    (g0 & 0xffc0) === 0xfec0 ||
    (g0 & 0xff00) === 0xff00
  );
}

/**
 * The default way pages are fetched: Node's http(s) client with a DNS lookup
 * that refuses private addresses at the moment of connecting, so a host
 * cannot pass the check with a public address and then resolve to an
 * internal one (DNS rebinding).
 */
export const pinnedFetch: FetchLike = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const u = new URL(input);
    const client = u.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req = client.request(
      u,
      {
        method: init?.method ?? "GET",
        headers,
        signal: init?.signal ?? undefined,
        lookup: (hostname, options, callback) => {
          dnsLookupCb(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
            if (err) return callback(err, "", 4);
            const list = addresses as unknown as LookupAddress[];
            const ok = list.length > 0 && list.every((a) => !isPrivateAddress(a.address));
            if (!ok) return callback(new UnsafeUrlError("عنوان داخلي غير مسموح"), "", 4);
            if ((options as { all?: boolean }).all)
              return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
            const first = list[0] as LookupAddress;
            callback(null, first.address, first.family);
          });
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : v);
        const empty =
          status === 204 || status === 205 || status === 304 || (status >= 300 && status < 400);
        if (empty) res.resume();
        resolve(
          new Response(
            empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
            { status: status < 200 || status > 599 ? 502 : status, headers: out },
          ),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

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
  const fetchFn: FetchLike = opts.fetch ?? pinnedFetch;
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
