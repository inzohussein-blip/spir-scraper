import Link from "next/link";
import { type BoardCard, LeadsBoard } from "@/components/leads-board";
import { LinkButton, Notice } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";
import { STATUS_LABELS } from "@/lib/status";
import { fillTemplate, waLink } from "@/lib/whatsapp";

export const metadata = { title: "لوحة العملاء" };

const STATUSES = ["new", "contacted", "interested", "customer", "rejected"] as const;
/** Cards per column; the list page holds the rest. */
const PER_COLUMN = 50;

export default async function LeadsBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const q = await searchParams;
  const rt = await getRuntime();
  const projects = await rt.scrapers.listProjects();
  const projectId = q.project ?? projects[0]?.id;
  const project = projects.find((p) => p.id === projectId);
  if (!projectId || !project) return <Notice tone="info">لا توجد مشاريع بعد.</Notice>;

  const [pages, counts] = await Promise.all([
    Promise.all(
      STATUSES.map((status) => rt.scrapers.listLeadsPage({ projectId, status, limit: PER_COLUMN })),
    ),
    rt.scrapers.leadStatusCounts(projectId),
  ]);
  const columns = STATUSES.map((status, i) => ({
    status,
    label: STATUS_LABELS[status] ?? status,
    total: counts[status] ?? 0,
    cards: (pages[i]?.leads ?? []).map(
      (r): BoardCard => ({
        username: r.username,
        fullName: r.fullName,
        aiScore: r.aiScore,
        followers: r.followers,
        followUpAt: r.followUpAt ? new Date(r.followUpAt).toISOString().slice(0, 10) : null,
        whatsapp: waLink(r.phone, r.phoneConfirmed, fillTemplate(project.messageTemplate, r)),
      }),
    ),
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">لوحة العملاء · {project.name}</h1>
        <div className="ms-auto flex flex-wrap gap-2">
          {projects.length > 1 &&
            projects.map((p) => (
              <Link
                key={p.id}
                href={`/leads/board?project=${p.id}`}
                className={
                  p.id === projectId
                    ? "rounded-full bg-accent-soft px-3 py-1 text-sm text-accent"
                    : "rounded-full bg-bg-2 px-3 py-1 text-sm text-fg-2"
                }
              >
                {p.name}
              </Link>
            ))}
          <LinkButton href={`/leads?project=${projectId}`}>عرض القائمة</LinkButton>
        </div>
      </div>
      <p className="text-sm text-muted">
        اسحب البطاقة إلى عمود آخر لتغيير حالتها. يظهر في كل عمود أفضل {PER_COLUMN} حسب الدرجة.
      </p>
      <LeadsBoard projectId={projectId} columns={columns} />
    </div>
  );
}
