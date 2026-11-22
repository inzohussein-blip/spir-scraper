"use client";

import { useTransition } from "react";
import { setLeadStatus } from "@/app/actions";
import { STATUS_LABELS } from "@/lib/status";
import { cx } from "./ui";

const TONE: Record<string, string> = {
  new: "bg-bg-2 text-fg-2",
  contacted: "bg-info-soft text-info",
  interested: "bg-warn-soft text-warn",
  customer: "bg-ok-soft text-ok",
  rejected: "bg-bad-soft text-bad",
};

/** Per-lead CRM status, saved as soon as it changes. */
export function StatusSelect({
  projectId,
  username,
  status,
}: {
  projectId: string;
  username: string;
  status: string;
}) {
  const [pending, start] = useTransition();
  return (
    <select
      aria-label={`حالة @${username}`}
      defaultValue={status}
      disabled={pending}
      onChange={(e) => {
        const value = e.target.value;
        start(() => setLeadStatus(projectId, username, value));
      }}
      className={cx(
        "rounded-full border-0 px-2.5 py-1 text-xs font-semibold outline-none",
        TONE[status] ?? TONE.new,
        pending && "opacity-60",
      )}
    >
      {Object.entries(STATUS_LABELS).map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}
