import type { FetchLike } from "./providers/types.js";

/** The platform API accepts at most this many accounts per job. */
export const JOB_MAX = 1000;

/** Client for the owner's Scrapers platform REST API (/api/v1). */
export class Platform {
  private readonly base: string;
  constructor(
    url: string,
    private readonly key: string,
    private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
  ) {
    this.base = `${url.replace(/\/$/, "")}/api/v1`;
  }

  get configured(): boolean {
    return /^https?:\/\//.test(this.base) && this.key.length > 0;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.configured) throw new Error("اربط المنصة أولاً من الإعدادات (الرابط ومفتاح API)");
    const res = await this.fetchFn(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      if (res.status === 401) throw new Error("مفتاح المنصة غير صحيح أو بلا صلاحية");
      throw new Error(body.error ?? `المنصة ردت بالخطأ ${res.status}`);
    }
    return body;
  }

  async projects(): Promise<{ id: string; name: string }[]> {
    const r = await this.call<{ projects: { id: string; name: string }[] }>("/projects");
    return r.projects.map((p) => ({ id: p.id, name: p.name }));
  }

  /** The stored profile, or null when the account was never collected. */
  async lookup(username: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.call<Record<string, unknown>>(
        `/profiles/${encodeURIComponent(username.replace(/^@/, "").toLowerCase())}`,
      );
    } catch (err) {
      if (/not collected|404/i.test((err as Error).message)) return null;
      throw err;
    }
  }

  /** The project's name and AI criteria (what a good lead looks like). */
  async project(projectId: string): Promise<{ name: string; aiCriteria: string | null }> {
    const r = await this.call<{ name: string; aiCriteria: string | null }>(
      `/projects/${encodeURIComponent(projectId)}`,
    );
    return { name: r.name, aiCriteria: r.aiCriteria ?? null };
  }

  /** The account's lead in this project (CRM status and score), or null. */
  async lead(
    projectId: string,
    username: string,
  ): Promise<{ status: string; aiScore: number | null } | null> {
    const u = username.replace(/^@/, "").toLowerCase();
    const r = await this.call<{
      leads: { username: string; status: string; aiScore: number | null }[];
    }>(`/leads?project=${encodeURIComponent(projectId)}&q=${encodeURIComponent(u)}&limit=20`);
    const hit = r.leads.find((l) => l.username.toLowerCase() === u);
    return hit ? { status: hit.status, aiScore: hit.aiScore ?? null } : null;
  }

  /** Links an account on another platform to the person behind an Instagram lead. */
  async addAccount(username: string, url: string): Promise<{ account: Record<string, unknown> }> {
    return this.call<{ account: Record<string, unknown> }>("/accounts", {
      method: "POST",
      body: JSON.stringify({ username: username.replace(/^@/, "").trim().toLowerCase(), url }),
    });
  }

  /** Queues jobs (the API takes up to 1000 accounts each) that collect public details and contacts. */
  async save(projectId: string, usernames: string[]): Promise<{ jobIds: string[]; count: number }> {
    if (!projectId) throw new Error("اختر مشروعاً من الإعدادات");
    const clean = [...new Set(usernames.map((u) => u.replace(/^@/, "").trim().toLowerCase()))]
      .filter((u) => /^[a-z0-9._]{1,30}$/.test(u))
      .slice(0, 5000);
    if (clean.length === 0) throw new Error("لا توجد أسماء صالحة للحفظ");
    const jobIds: string[] = [];
    for (let i = 0; i < clean.length; i += JOB_MAX) {
      const batch = clean.slice(i, i + JOB_MAX);
      const r = await this.call<{ job: { id: string } }>("/jobs", {
        method: "POST",
        body: JSON.stringify({ projectId, usernames: batch, limit: batch.length }),
      });
      jobIds.push(r.job.id);
    }
    return { jobIds, count: clean.length };
  }
}
