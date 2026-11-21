import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "@/app/actions";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/", label: "الرئيسية" },
  { href: "/jobs/new", label: "مهمة جديدة" },
  { href: "/leads", label: "العملاء" },
  { href: "/settings", label: "الإعدادات" },
];

export default async function DashLayout({ children }: { children: ReactNode }) {
  await requireSession();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--card)]/90 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-4 py-3">
          <Link href="/" className="me-4 text-lg font-bold text-brand">
            Scrapers
          </Link>
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="rounded-lg px-3 py-1.5 text-sm hover:bg-brand-soft hover:text-brand"
            >
              {n.label}
            </Link>
          ))}
          <form action={logout} className="ms-auto">
            <button
              type="submit"
              className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:text-red-600"
            >
              خروج
            </button>
          </form>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">{children}</main>
    </div>
  );
}
