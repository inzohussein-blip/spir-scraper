import { createHash } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { normalizeEmail, normalizeUsername, toLatinDigits } from "./normalize.js";

export type SuppressionKind = "username" | "email" | "phone";

export function normalizeForSuppression(kind: SuppressionKind, value: string): string {
  switch (kind) {
    case "username":
      return normalizeUsername(value);
    case "email":
      return normalizeEmail(value);
    case "phone": {
      const v = toLatinDigits(value).trim();
      const n = parsePhoneNumberFromString(v.startsWith("00") ? `+${v.slice(2)}` : v);
      return n?.number ?? v.replace(/[^\d+]/g, "");
    }
  }
}

/** sha256(kind:normalised value + pepper). The raw value is never stored. */
export function suppressionHash(kind: SuppressionKind, value: string, pepper: string): string {
  if (!pepper) throw new Error("SUPPRESSION_PEPPER is not set");
  return createHash("sha256")
    .update(`${kind}:${normalizeForSuppression(kind, value)}${pepper}`)
    .digest("hex");
}
