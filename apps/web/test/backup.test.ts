import { describe, expect, it } from "vitest";
import { openBackup, sealBackup } from "../lib/backup";
import { open, proxyLabel, seal } from "../lib/secretbox";

describe("encrypted backups and proxies", () => {
  it("opens only its own sealed backups, with the same AUTH_SECRET", () => {
    process.env.AUTH_SECRET = "secret-one";
    const data = new TextEncoder().encode("gzip bytes");
    const sealed = sealBackup(data);
    expect(new TextDecoder().decode(sealed.subarray(0, 7))).toBe("SPIRBK1");
    expect(Buffer.from(sealed).includes(Buffer.from("gzip bytes"))).toBe(false);
    expect(openBackup(sealed)).toEqual(data);
    // Altered, foreign or sealed with another secret: refused.
    const altered = new Uint8Array(sealed);
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
    expect(openBackup(altered)).toBeNull();
    expect(openBackup(data)).toBeNull();
    process.env.AUTH_SECRET = "secret-two";
    expect(openBackup(sealed)).toBeNull();
  });

  it("keeps proxy passwords encrypted and labels them by host only", () => {
    process.env.AUTH_SECRET = "s";
    const url = "http://user:pw@proxy.example:8000";
    const sealed = seal(url);
    expect(sealed).not.toContain("pw");
    expect(open(sealed)).toBe(url);
    expect(proxyLabel(url)).toBe("proxy.example:8000");
  });
});
