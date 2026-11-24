/**
 * The project's leads kept on this computer for the Instagram badge: it is
 * downloaded once a day (one request) and every profile is looked up here,
 * instead of asking the platform for each profile visited. Free plans count
 * every request, and browsing Instagram visits many profiles.
 */
export interface LeadIndex {
  projectId: string;
  /** When it was downloaded (ms). */
  at: number;
  /** username → [status, AI score]. */
  leads: Record<string, [string, number | null]>;
}

export const INDEX_MAX_AGE_MS = 24 * 3600_000;

export function needsRefresh(
  idx: LeadIndex | null | undefined,
  projectId: string,
  now = Date.now(),
) {
  return !idx || idx.projectId !== projectId || now - idx.at > INDEX_MAX_AGE_MS;
}

export function fromEntries(
  projectId: string,
  entries: [string, string, number | null][],
  now = Date.now(),
): LeadIndex {
  const leads: LeadIndex["leads"] = {};
  for (const [u, status, score] of entries) leads[u.toLowerCase()] = [status, score];
  return { projectId, at: now, leads };
}

/** The lead in this project, or null when the account is not in it. */
export function lookup(
  idx: LeadIndex,
  username: string,
): { status: string; aiScore: number | null } | null {
  const hit = idx.leads[username.replace(/^@/, "").toLowerCase()];
  return hit ? { status: hit[0], aiScore: hit[1] } : null;
}

/** Marks an account just saved from the badge, without downloading the list again. */
export function withSaved(idx: LeadIndex, username: string): LeadIndex {
  const u = username.replace(/^@/, "").toLowerCase();
  return idx.leads[u] ? idx : { ...idx, leads: { ...idx.leads, [u]: ["new", null] } };
}
