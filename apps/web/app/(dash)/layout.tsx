import type { ReactNode } from "react";
import { logout } from "@/app/actions";
import { Shell } from "@/components/shell";
import { requireSession } from "@/lib/auth";
import { meter } from "@/lib/meter";
import { getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export default async function DashLayout({ children }: { children: ReactNode }) {
  await requireSession();
  meter("dashboard");
  const rt = await getRuntime();
  const [unread, projects, jobs] = await Promise.all([
    rt.scrapers.unreadNotifications(),
    rt.scrapers.listProjects(),
    rt.scrapers.listJobs({ limit: 10 }),
  ]);
  return (
    <Shell
      logout={logout}
      data={{
        unread,
        activeJobs: jobs.filter((j) => j.status === "queued" || j.status === "running").length,
        projects: projects.map((p) => ({ id: p.id, name: p.name })),
        jobs: jobs.map((j) => ({ id: j.id, label: j.sourceUrl, status: j.status })),
      }}
    >
      {children}
    </Shell>
  );
}
