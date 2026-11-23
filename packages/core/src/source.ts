import { parse } from "csv-parse/sync";
import { normalizeUsername } from "./normalize.js";
import type { Source, SourceType } from "./types.js";

export class SourceError extends Error {
  override name = "SourceError";
}

const USERNAME_RE = /^[a-z0-9._]{1,30}$/;
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
/** First path segments that are Instagram pages, not usernames. */
const RESERVED = new Set([
  "explore",
  "accounts",
  "p",
  "reel",
  "reels",
  "tv",
  "stories",
  "direct",
  "about",
  "legal",
  "developer",
]);

function searchSource(query: string): Extract<Source, { type: "search" }> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 100);
  if (!q) throw new SourceError("Empty search");
  return {
    type: "search",
    query: q,
    url: `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`,
  };
}

function followersOf(username: string): Extract<Source, { type: "followers" }> {
  return { type: "followers", username, url: `https://www.instagram.com/${username}/followers/` };
}

export function isValidUsername(u: string): boolean {
  return USERNAME_RE.test(u) && !u.startsWith(".") && !u.endsWith(".") && !u.includes("..");
}

/** Parses an Instagram URL, @username or #hashtag. Only instagram.com is accepted. */
export function parseSource(
  input: string,
  type?: Exclude<SourceType, "upload">,
): Exclude<Source, { type: "upload" }> {
  const s = input.trim();
  if (!s) throw new SourceError("Empty source");

  if (type === "search" && !/^https?:\/\//i.test(s)) return searchSource(s);

  if (s.startsWith("#") || (type === "hashtag" && !s.includes("/"))) {
    const tag = s.replace(/^#/, "").toLowerCase();
    if (!/^[\p{L}\p{N}_]{1,100}$/u.test(tag)) throw new SourceError(`Invalid hashtag: ${s}`);
    return {
      type: "hashtag",
      tag,
      url: `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`,
    };
  }

  if (!s.includes("/") && !s.includes(".com")) {
    const username = normalizeUsername(s);
    if (type === "similar" && isValidUsername(username))
      return { type: "similar", username, url: `https://www.instagram.com/${username}/` };
    if (!isValidUsername(username)) throw new SourceError(`Invalid username: ${s}`);
    return type === "followers"
      ? followersOf(username)
      : { type: "profile", username, url: `https://www.instagram.com/${username}/` };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new SourceError(`Invalid URL: ${s}`);
  }
  if (!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase()) || !/^https?:$/.test(url.protocol)) {
    throw new SourceError(`Only instagram.com links are accepted: ${s}`);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const [first, second, third] = parts;
  if ((first === "p" || first === "reel" || first === "reels" || first === "tv") && second) {
    return { type: "post", shortcode: second, url: `https://www.instagram.com/p/${second}/` };
  }
  // instagram.com/<user>/p/<code>/ and /<user>/reel/<code>/
  if (first && (second === "p" || second === "reel") && third) {
    return { type: "post", shortcode: third, url: `https://www.instagram.com/p/${third}/` };
  }
  if (first === "explore" && second === "search") {
    const q = url.searchParams.get("q");
    if (q) return searchSource(q);
  }
  if (first === "explore" && second === "locations" && third && /^\d+$/.test(third)) {
    return {
      type: "location",
      locationId: third,
      url: `https://www.instagram.com/explore/locations/${third}/`,
    };
  }
  if (first === "explore" && second === "tags" && third) {
    return parseSource(`#${decodeURIComponent(third)}`);
  }
  if (first && !RESERVED.has(first)) {
    const username = normalizeUsername(first);
    // instagram.com/<user>/followers/, or a profile link asked for as followers.
    if (isValidUsername(username) && (second === "followers" || type === "followers")) {
      return followersOf(username);
    }
    if (isValidUsername(username) && type === "similar") {
      return { type: "similar", username, url: `https://www.instagram.com/${username}/` };
    }
    if (isValidUsername(username)) {
      return { type: "profile", username, url: `https://www.instagram.com/${username}/` };
    }
  }
  throw new SourceError(`Unrecognised Instagram link: ${s}`);
}

const USERNAME_COLUMNS = [
  "username",
  "user",
  "handle",
  "instagram",
  "ig",
  "account",
  "url",
  "link",
  "اسم المستخدم",
  "المعرف",
  "المعرّف",
  "الحساب",
  "الرابط",
];

/**
 * Reads usernames from an uploaded CSV. Uses a column named like "username"
 * or "url" when there is a header, otherwise the first column. Accepts
 * usernames, @usernames and profile links; skips invalid and duplicate rows.
 */
export function parseUsernameCsv(csv: string, limit = 5000): string[] {
  const rows: string[][] = parse(csv.replace(/^﻿/, ""), {
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });
  if (rows.length === 0) return [];
  const header = (rows[0] ?? []).map((h) => h.toLowerCase());
  let col = header.findIndex((h) => USERNAME_COLUMNS.includes(h));
  const hasHeader = col !== -1;
  if (!hasHeader) col = 0;

  const out = new Set<string>();
  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    const cell = row[col];
    if (!cell) continue;
    try {
      const src = parseSource(cell, "profile");
      if (src.type === "profile") out.add(src.username);
    } catch {
      // Skip rows that are not usernames.
    }
    if (out.size >= limit) break;
  }
  return [...out];
}

export function uploadSource(usernames: string[], label = "upload.csv"): Source {
  return { type: "upload", usernames, url: label };
}
