/**
 * Spir engine mode: this browser reads public Instagram profiles slowly for
 * the platform, from the home connection, while it is open.
 *
 * Reads are anonymous: no cookies are sent (credentials: "omit"), so the
 * owner's Instagram session is never used and their account is never at risk.
 * The platform decides what to read and when; this only asks, reads, reports.
 */
import type { FetchLike } from "./providers/types.js";

export const IG_APP_ID = "936619743392459";

type J = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const count = (o: unknown, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = (o as J | undefined)?.[k] as J | undefined;
    if (v && typeof v.count === "number") return v.count;
  }
  return null;
};

/** Instagram's public profile JSON → the profile shape the platform stores. */
export function mapProfile(user: J): J {
  const edges = ((user.edge_owner_to_timeline_media as J | undefined)?.edges ?? []) as J[];
  const recentPosts = edges.slice(0, 12).flatMap((e) => {
    const n = e?.node as J | undefined;
    if (!n) return [];
    const cap = ((n.edge_media_to_caption as J | undefined)?.edges as J[] | undefined)?.[0]?.node as
      | J
      | undefined;
    const code = s(n.shortcode);
    return [
      {
        likes: count(n, "edge_liked_by", "edge_media_preview_like"),
        comments: count(n, "edge_media_to_comment"),
        caption: s(cap?.text)?.slice(0, 500) ?? null,
        url: code ? `https://www.instagram.com/p/${code}/` : null,
      },
    ];
  });
  return {
    igUserId: String(user.id ?? user.pk ?? user.username),
    username: String(user.username ?? "").toLowerCase(),
    fullName: s(user.full_name),
    bio: s(user.biography),
    followers: count(user, "edge_followed_by"),
    following: count(user, "edge_follow"),
    posts: count(user, "edge_owner_to_timeline_media"),
    isBusiness: user.is_business_account === true,
    isVerified: user.is_verified === true,
    category: s(user.business_category_name) ?? s(user.category_name),
    externalUrl: s(user.external_url),
    businessEmail: s(user.business_email) ?? s(user.public_email),
    businessPhone: s(user.business_phone_number) ?? s(user.public_phone_number),
    businessPhoneCountryCode: s(user.public_phone_country_code),
    businessWhatsapp: s(user.whatsapp_number),
    city: null,
    recentPosts: recentPosts.length ? recentPosts : null,
  };
}

export type ReadResult =
  | { status: "ok"; profile: J }
  | { status: "not_found" | "rate_limited" | "blocked" | "error"; message: string };

/** Reads one public profile without the owner's cookies. */
export async function readAnonymously(fetchFn: FetchLike, username: string): Promise<ReadResult> {
  let res: Response;
  try {
    res = await fetchFn(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      {
        credentials: "omit",
        headers: { "x-ig-app-id": IG_APP_ID, accept: "*/*" },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (err) {
    return { status: "error", message: (err as Error).message.slice(0, 200) };
  }
  if (res.status === 404) return { status: "not_found", message: "not found" };
  if (res.status === 429) return { status: "rate_limited", message: "Instagram: 429" };
  if (res.status === 401 || res.status === 403 || /\/accounts\/login|\/challenge/.test(res.url))
    return { status: "blocked", message: `Instagram: ${res.status} login required` };
  if (!res.ok) return { status: "error", message: `Instagram: HTTP ${res.status}` };
  const body = (await res.json().catch(() => null)) as J | null;
  if (!body)
    return { status: "blocked", message: "Instagram answered with a page instead of data" };
  const user = (body.data as J | undefined)?.user as J | undefined;
  if (!user) return { status: "not_found", message: "not found or private" };
  return { status: "ok", profile: mapProfile(user) };
}

export async function publicIp(fetchFn: FetchLike): Promise<string | null> {
  try {
    const r = await fetchFn("https://api.ipify.org?format=json", {
      credentials: "omit",
      signal: AbortSignal.timeout(15_000),
    });
    return s(((await r.json()) as J).ip);
  } catch {
    return null;
  }
}

type Item = { id: string; username: string };
export type Decision = (
  | { action: "wait"; seconds: number; reason: string }
  | { action: "read"; item: Item }
  | { action: "batch"; items: Item[]; intervalSec: number; jitterSec: number }
) & { commands?: { type: string }[] };

export interface EngineState {
  enabled: boolean;
  workerId: string;
  ip: string | null;
  /** What happened last, for the side panel. */
  last: { at: string; text: string } | null;
  readToday: number;
  day: string;
  /**
   * The batch being read: the platform is contacted once per batch (reports
   * are kept here until then), which keeps its free plans free.
   */
  batch?: {
    items: { id: string; username: string }[];
    intervalSec: number;
    jitterSec: number;
    reports: J[];
  } | null;
}

/**
 * One visit to the platform: ask, maybe read and report, and return how many
 * seconds to wait before the next visit.
 */
export async function engineTick(opts: {
  platformUrl: string;
  key: string;
  state: EngineState;
  version: string;
  fetchFn?: FetchLike;
  now?: Date;
}): Promise<{ waitSeconds: number; state: EngineState }> {
  const fetchFn = opts.fetchFn ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? new Date();
  const state = { ...opts.state };
  const day = now.toISOString().slice(0, 10);
  if (state.day !== day) Object.assign(state, { day, readToday: 0 });
  const base = opts.platformUrl.replace(/\/$/, "");
  const worker = () => ({
    id: state.workerId,
    kind: "extension",
    name: "متصفح",
    version: opts.version,
    ip: state.ip,
    batch: true,
  });
  const post = async (path: string, body: J): Promise<Decision> => {
    const r = await fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 404 || r.status === 401)
      throw new Error("المنصة رفضت المحرك: تأكد من المفتاح (صلاحية كتابة) ومن رابط المنصة");
    if (!r.ok) throw new Error(`المنصة ردت بالخطأ ${r.status}`);
    return (await r.json()) as Decision;
  };
  const note = (text: string) => {
    state.last = { at: now.toISOString(), text };
  };
  if (!state.ip) state.ip = await publicIp(fetchFn);

  const take = (d: Decision): boolean => {
    if (d.action === "batch")
      state.batch = {
        items: [...d.items],
        intervalSec: d.intervalSec,
        jitterSec: d.jitterSec,
        reports: [],
      };
    else if (d.action === "read")
      state.batch = { items: [d.item], intervalSec: 30, jitterSec: 0, reports: [] };
    else {
      if (state.last === null || d.reason !== "pace")
        note(WAIT_TEXT[d.reason] ?? `انتظار (${d.reason})`);
      return false;
    }
    return true;
  };
  const pace = () => {
    const b = state.batch;
    return b ? b.intervalSec + Math.random() * b.jitterSec : 60;
  };

  try {
    if (!state.batch) {
      const d = await post("/api/engine/next", { worker: worker() });
      if (d.commands?.some((c) => c.type === "check_ip")) state.ip = await publicIp(fetchFn);
      if (!take(d)) return { waitSeconds: waitOf(d), state };
    }
    const b = state.batch as NonNullable<EngineState["batch"]>;
    const item = b.items.shift();
    if (item) {
      const r = await readAnonymously(fetchFn, item.username);
      state.readToday += r.status === "ok" || r.status === "not_found" ? 1 : 0;
      note(`@${item.username}: ${r.status === "ok" ? "قُرئ" : r.status}`);
      b.reports.push({ itemId: item.id, ...r, exitId: "direct" });
      if (r.status === "rate_limited" || r.status === "blocked") {
        // Instagram asked to slow down: hand the rest back unread.
        b.reports.push(...b.items.map((it) => ({ itemId: it.id, status: "released" })));
        b.items = [];
      }
    }
    if (b.items.length > 0) return { waitSeconds: Math.max(20, pace()), state };
    // The batch is done: one visit reports it all and gets what is next.
    const d = await post("/api/engine/report", { reports: b.reports, worker: worker() });
    state.batch = null;
    if (take(d)) return { waitSeconds: Math.max(20, pace()), state };
    return { waitSeconds: waitOf(d), state };
  } catch (err) {
    // Reports already made stay in state.batch and are sent on the next try.
    note((err as Error).message);
    return { waitSeconds: 300, state };
  }
}

function waitOf(d: Decision): number {
  return d.action === "wait" ? Math.max(30, Math.min(d.seconds, 3600)) : 30;
}

export const WAIT_TEXT: Record<string, string> = {
  pace: "ينتظر دوره",
  idle: "لا يوجد ما يقرأه: أنشئ تشغيلاً في صفحة محرك Spir",
  resting: "يستريح بطلب من إنستقرام",
  quiet: "ساعات الراحة",
  daily_cap: "بلغ حد اليوم",
  paused: "المحرك متوقف من اللوحة",
  worker_off: "هذا المتصفح موقوف من صفحة العامل المنزلي",
};
