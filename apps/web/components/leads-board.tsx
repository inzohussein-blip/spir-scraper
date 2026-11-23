"use client";

import { useState, useTransition } from "react";
import { setLeadStatus } from "@/app/actions";
import { cx } from "./ui";

export interface BoardCard {
  username: string;
  fullName: string | null;
  aiScore: number | null;
  followers: number | null;
  followUpAt: string | null;
  whatsapp: string | null;
}

interface Column {
  status: string;
  label: string;
  total: number;
  cards: BoardCard[];
}

/** Kanban columns by CRM status; dropping a card saves its new status. */
export function LeadsBoard({ projectId, columns }: { projectId: string; columns: Column[] }) {
  const [cols, setCols] = useState(columns);
  const [over, setOver] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function move(username: string, to: string) {
    const from = cols.find((c) => c.cards.some((x) => x.username === username));
    if (!from || from.status === to) return;
    const card = from.cards.find((x) => x.username === username);
    if (!card) return;
    setCols((prev) =>
      prev.map((c) =>
        c.status === from.status
          ? { ...c, total: c.total - 1, cards: c.cards.filter((x) => x.username !== username) }
          : c.status === to
            ? { ...c, total: c.total + 1, cards: [card, ...c.cards] }
            : c,
      ),
    );
    start(() => setLeadStatus(projectId, username, to));
  }

  return (
    <div className={cx("grid gap-3 overflow-x-auto pb-2 md:grid-cols-5", pending && "opacity-90")}>
      {cols.map((c) => (
        <section
          key={c.status}
          data-status={c.status}
          aria-label={c.label}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(c.status);
          }}
          onDragLeave={() => setOver((s) => (s === c.status ? null : s))}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            move(e.dataTransfer.getData("text/plain"), c.status);
          }}
          className={cx(
            "min-h-40 min-w-56 rounded-xl border border-line bg-surface-2 p-2",
            over === c.status && "border-accent",
          )}
        >
          <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold">
            {c.label}
            <span className="text-xs text-muted tabular-nums">{c.total}</span>
          </h2>
          <ul className="space-y-2">
            {c.cards.map((card) => (
              <li
                key={card.username}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/plain", card.username)}
                className="cursor-grab rounded-lg border border-line bg-surface p-2.5 text-sm shadow-sm active:cursor-grabbing"
              >
                <a
                  href={`https://www.instagram.com/${card.username}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ltr block font-medium hover:text-accent"
                >
                  @{card.username}
                </a>
                {card.fullName && <div className="truncate text-xs text-fg-2">{card.fullName}</div>}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {card.aiScore !== null && <span>الدرجة {card.aiScore}</span>}
                  {card.followers !== null && (
                    <span>{card.followers.toLocaleString("ar")} متابع</span>
                  )}
                  {card.followUpAt && <span className="text-warn">تذكير {card.followUpAt}</span>}
                </div>
                {card.whatsapp && (
                  <a
                    href={card.whatsapp}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 inline-block text-xs text-ok hover:underline"
                  >
                    واتساب ←
                  </a>
                )}
                {/* Keyboard and touch: change the column without dragging. */}
                <select
                  aria-label={`نقل @${card.username}`}
                  value={c.status}
                  onChange={(e) => move(card.username, e.target.value)}
                  className="mt-1.5 block w-full rounded-md border border-line bg-bg px-1 py-0.5 text-xs"
                >
                  {cols.map((o) => (
                    <option key={o.status} value={o.status}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
