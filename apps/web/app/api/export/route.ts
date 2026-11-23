import { hasSession } from "@/lib/auth";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Dashboard download: /api/export?project=...&format=csv|xlsx[&job=...&business=1&has_phone=1...] */
export async function GET(req: Request) {
  if (!(await hasSession())) return new Response("unauthorized", { status: 401 });
  const q = new URL(req.url).searchParams;
  const format = q.get("format") === "csv" ? "csv" : "xlsx";
  const projectId = q.get("project");
  if (!projectId) return new Response("project is required", { status: 400 });
  const r = await (await getRuntime()).exportLeads({
    projectId,
    format,
    ...(q.get("job") ? { jobId: q.get("job") as string } : {}),
    filters: {
      ...(q.get("business") ? { business: true } : {}),
      ...(q.get("has_email") ? { hasEmail: true } : {}),
      ...(q.get("has_phone") ? { hasPhone: true } : {}),
      ...(q.get("min_score") ? { minScore: Number(q.get("min_score")) } : {}),
      ...(q.get("q") ? { q: q.get("q") as string } : {}),
      ...(/^[A-Za-z]{2}$/.test(q.get("country") ?? "")
        ? { country: q.get("country") as string }
        : {}),
      ...(/^[a-z]{2}$/.test(q.get("language") ?? "")
        ? { language: q.get("language") as string }
        : {}),
      ...(Number(q.get("min_sources")) > 1 ? { minSources: Number(q.get("min_sources")) } : {}),
      ...(["new", "contacted", "interested", "customer", "rejected"].includes(q.get("status") ?? "")
        ? { status: q.get("status") as "new" }
        : {}),
    },
  });
  if (r.kind !== "file") return new Response("unexpected", { status: 500 });
  return new Response(new Uint8Array(r.data), {
    headers: {
      "content-type": r.contentType,
      "content-disposition": `attachment; filename="scrapers-export.${r.filename.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(r.filename)}`,
      "cache-control": "no-store",
    },
  });
}
