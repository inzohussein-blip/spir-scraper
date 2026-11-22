import { promises as dns } from "node:dns";

export type EmailDomainStatus = "valid" | "invalid" | "unknown";

export interface MxResolver {
  resolveMx(domain: string): Promise<unknown[]>;
  resolve4(domain: string): Promise<unknown[]>;
}

const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "ESERVFAIL"]);

/**
 * Checks that an email's domain can receive mail (MX record, or an A record as
 * the RFC 5321 fallback). No message is ever sent. DNS failures that are not
 * a clear "no such domain" return "unknown", and the email is kept.
 */
export function createMxChecker(opts: { resolver?: MxResolver; timeoutMs?: number } = {}) {
  const resolver = opts.resolver ?? dns;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const cache = new Map<string, Promise<EmailDomainStatus>>();

  const withTimeout = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })),
          timeoutMs,
        ),
      ),
    ]);

  async function lookup(domain: string): Promise<EmailDomainStatus> {
    try {
      const mx = await withTimeout(resolver.resolveMx(domain));
      if (mx.length > 0) return "valid";
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (!NOT_FOUND.has(code)) return "unknown";
    }
    try {
      const a = await withTimeout(resolver.resolve4(domain));
      return a.length > 0 ? "valid" : "invalid";
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      return NOT_FOUND.has(code) ? "invalid" : "unknown";
    }
  }

  return (email: string): Promise<EmailDomainStatus> => {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return Promise.resolve("invalid");
    let p = cache.get(domain);
    if (!p) {
      p = lookup(domain);
      cache.set(domain, p);
    }
    return p;
  };
}
