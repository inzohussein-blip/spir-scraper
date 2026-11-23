/** Messages between the side panel and the content script. */
export type PageRequest =
  | { kind: "snapshot" }
  | { kind: "click"; id: number }
  | { kind: "type"; id: number; text: string; submit?: boolean }
  | { kind: "scroll"; direction: "down" | "up"; id?: number }
  | { kind: "instagram_profile" }
  | { kind: "collect_start" }
  | { kind: "collect_get" }
  | { kind: "collect_clear" }
  | { kind: "post_comments" }
  | { kind: "page_meta" };

export type PageResponse =
  | { ok: true; text?: string; data?: unknown }
  | { ok: false; error: string };

export interface InstagramProfile {
  username: string | null;
  name: string | null;
  bio: string | null;
  followers: number | null;
  following: number | null;
  posts: number | null;
  externalUrl: string | null;
  emails: string[];
  phones: string[];
  url: string;
}

export interface CollectState {
  collecting: boolean;
  usernames: string[];
  /** The account whose list is open, excluded from the results. */
  owner: string | null;
}
