"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";
import { cx } from "./ui";

export type ShellData = {
  unread: number;
  activeJobs: number;
  projects: { id: string; name: string }[];
  jobs: { id: string; label: string; status: string }[];
};

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "نظرة عامة", icon: "home" },
  { href: "/jobs/new", label: "مهمة جديدة", icon: "plus" },
  { href: "/leads", label: "العملاء", icon: "users" },
  { href: "/competitors", label: "المنافسون", icon: "radar" },
  { href: "/places", label: "الشركات", icon: "folder" },
  { href: "/engine", label: "محرك Spir", icon: "activity" },
  { href: "/insights", label: "العائد", icon: "chart" },
  { href: "/partners", label: "الوكلاء", icon: "users" },
  { href: "/own", label: "حسابي", icon: "chart" },
  { href: "/inbox", label: "الرسائل", icon: "bell" },
  { href: "/content", label: "المحتوى", icon: "sparkles" },
  { href: "/market", label: "السوق", icon: "radar" },
  { href: "/notifications", label: "الإشعارات", icon: "bell" },
  { href: "/activity", label: "النشاط", icon: "activity" },
  { href: "/extension", label: "إضافة المتصفح", icon: "plug" },
  { href: "/settings", label: "الإعدادات", icon: "settings" },
];

const TITLES: Record<string, string> = {
  "/": "نظرة عامة",
  "/jobs/new": "مهمة جديدة",
  "/leads": "العملاء",
  "/competitors": "المنافسون",
  "/places": "الشركات",
  "/engine": "محرك Spir",
  "/insights": "العائد",
  "/partners": "الوكلاء",
  "/own": "حسابي",
  "/inbox": "الرسائل",
  "/content": "المحتوى",
  "/market": "السوق",
  "/notifications": "الإشعارات",
  "/activity": "النشاط",
  "/settings": "الإعدادات",
};

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setDark(t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);
  const toggle = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("scrapers-theme", next);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    setDark(!dark);
  };
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-fg-2 hover:bg-surface-2"
    >
      <Icon name={dark ? "sun" : "moon"} />
      {dark ? "الوضع الفاتح" : "الوضع الليلي"}
    </button>
  );
}

/** Ctrl+K: jump to any page, project or recent job. */
function CommandPalette({
  data,
  open,
  onClose,
}: {
  data: ShellData;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const items = useMemo(() => {
    const all = [
      ...NAV.map((n) => ({ href: n.href, label: n.label, group: "الصفحات" })),
      ...data.projects.map((p) => ({
        href: `/leads?project=${p.id}`,
        label: p.name,
        group: "المشاريع",
      })),
      ...data.jobs.map((j) => ({ href: `/jobs/${j.id}`, label: j.label, group: "آخر المهام" })),
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    // Labels that start with the search come first (a project named «وكلاء» before «الوكلاء»).
    const hits = all.filter((i) => i.label.toLowerCase().includes(needle));
    return [
      ...hits.filter((i) => i.label.toLowerCase().startsWith(needle)),
      ...hits.filter((i) => !i.label.toLowerCase().startsWith(needle)),
    ];
  }, [data, q]);

  useEffect(() => {
    if (open) {
      setQ("");
      setIndex(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;
  const go = (href: string) => {
    onClose();
    router.push(href);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the dialog; Escape is handled on the input
    <div
      className="fixed inset-0 z-50 grid place-items-start bg-black/40 px-4 pt-[12vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="card mx-auto w-full max-w-lg overflow-hidden shadow-[var(--shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="بحث سريع"
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Icon name="search" className="size-4 text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, items.length - 1));
              else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
              else if (e.key === "Enter" && items[index]) go(items[index].href);
              else if (e.key === "Escape") onClose();
            }}
            placeholder="ابحث عن صفحة أو مشروع أو مهمة…"
            className="w-full bg-transparent py-3.5 text-sm outline-none"
          />
        </div>
        <ul className="max-h-80 overflow-y-auto p-2">
          {items.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted">لا نتائج</li>
          )}
          {items.map((item, i) => (
            <li key={`${item.group}${item.href}`}>
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => go(item.href)}
                className={cx(
                  "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-start text-sm",
                  i === index ? "bg-accent-soft text-accent" : "hover:bg-surface-2",
                )}
              >
                <span className="truncate">{item.label}</span>
                <span className="shrink-0 text-xs text-muted">{item.group}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Shell({
  data,
  logout,
  children,
}: {
  data: ShellData;
  logout: () => Promise<void>;
  children: ReactNode;
}) {
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const closePalette = useCallback(() => setPalette(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    // Marks the page interactive (keyboard shortcuts attached); end-to-end tests wait for it.
    document.documentElement.dataset.ready = "1";
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close the mobile menu after navigating.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on path change only
  useEffect(() => setMenu(false), [path]);

  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const title =
    path.startsWith("/jobs/") && path !== "/jobs/new" ? "تفاصيل المهمة" : (TITLES[path] ?? "");

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[252px_1fr]">
      <aside
        className={cx(
          "fixed inset-y-0 start-0 z-40 flex w-[252px] flex-col gap-1.5 overflow-y-auto border-e border-line bg-surface px-3.5 py-[18px] transition-transform md:sticky md:top-0 md:h-dvh md:translate-x-0",
          menu ? "translate-x-0" : "translate-x-full",
        )}
      >
        <Link href="/" className="flex items-center gap-2.5 px-2 pt-1 pb-4 text-[15.5px] font-bold">
          <span className="grid size-[34px] place-items-center rounded-[10px] bg-gradient-to-br from-accent to-accent-2 text-white shadow-[0_6px_16px_rgba(91,91,247,.35)]">
            <Icon name="radar" className="size-[19px]" />
          </span>
          Scrapers
        </Link>
        <nav className="grid gap-0.5">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cx(
                "flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 font-medium",
                active(n.href)
                  ? "bg-accent-soft text-accent"
                  : "text-fg-2 hover:bg-surface-2 hover:text-fg",
              )}
            >
              <Icon name={n.icon} />
              {n.label}
              {n.href === "/notifications" && data.unread > 0 && (
                <span className="ms-auto rounded-full bg-bad px-2 text-[11.5px] text-white">
                  {data.unread}
                </span>
              )}
            </Link>
          ))}
        </nav>
        {data.projects.length > 0 && (
          <>
            <div className="px-2.5 pt-3.5 pb-1.5 text-[11.5px] text-muted">المشاريع</div>
            <nav className="grid gap-0.5">
              {data.projects.slice(0, 8).map((p) => (
                <Link
                  key={p.id}
                  href={`/leads?project=${p.id}`}
                  className="flex items-center gap-2.5 truncate rounded-[10px] px-3.5 py-1.5 text-[13.5px] text-fg-2 hover:bg-surface-2"
                >
                  <Icon name="folder" className="size-4 text-muted" />
                  <span className="truncate">{p.name}</span>
                </Link>
              ))}
            </nav>
          </>
        )}
        <div className="mt-auto grid gap-1 border-t border-line pt-3">
          <ThemeToggle />
          <form action={logout}>
            <button
              type="submit"
              className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-fg-2 hover:bg-bad-soft hover:text-bad"
            >
              <Icon name="logout" />
              خروج
            </button>
          </form>
        </div>
      </aside>
      {menu && (
        // biome-ignore lint/a11y/noStaticElementInteractions: tapping the backdrop closes the mobile menu
        <div
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={() => setMenu(false)}
          role="presentation"
        />
      )}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-bg/80 px-4 py-3.5 backdrop-blur md:px-7">
          <button
            type="button"
            className="rounded-lg p-2 hover:bg-surface-2 md:hidden"
            onClick={() => setMenu(true)}
            aria-label="القائمة"
          >
            <Icon name="menu" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold">{title}</h1>
            {data.activeJobs > 0 && (
              <p className="flex items-center gap-1.5 text-[12.5px] text-muted">
                <span className="pulse inline-block size-2 rounded-full bg-warn" />
                {data.activeJobs} مهمة قيد التشغيل
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="hidden min-w-56 items-center gap-2 rounded-[10px] border border-line bg-surface px-3 py-2 text-sm text-muted sm:flex"
          >
            <Icon name="search" className="size-4" />
            بحث سريع
            <kbd className="ms-auto rounded-md border border-line px-1.5 text-[11px]">Ctrl K</kbd>
          </button>
          <Link
            href="/notifications"
            className="relative rounded-[10px] border border-line bg-surface p-2 hover:bg-surface-2"
            aria-label="الإشعارات"
          >
            <Icon name="bell" />
            {data.unread > 0 && (
              <span className="absolute -top-1.5 -end-1.5 min-w-5 rounded-full bg-bad px-1 text-center text-[11px] leading-5 text-white">
                {data.unread > 99 ? "99+" : data.unread}
              </span>
            )}
          </Link>
        </header>
        <main className="w-full max-w-[1280px] space-y-4 px-4 pt-6 pb-12 md:px-7">{children}</main>
      </div>
      <CommandPalette data={data} open={palette} onClose={closePalette} />
    </div>
  );
}
