"use client";

import { useTransition } from "react";
import { setFollowUp } from "@/app/actions";
import { cx } from "./ui";

/** A date to be reminded about a lead (on Telegram and in the bell, with the daily task). */
export function FollowUpInput({
  projectId,
  username,
  at,
}: {
  projectId: string;
  username: string;
  at: Date | null | undefined;
}) {
  const [pending, start] = useTransition();
  return (
    <input
      type="date"
      aria-label={`تذكير متابعة @${username}`}
      title="تذكير بالمتابعة في هذا اليوم"
      defaultValue={at ? new Date(at).toISOString().slice(0, 10) : ""}
      disabled={pending}
      onChange={(e) => {
        const day = e.target.value;
        start(() => setFollowUp(projectId, username, day));
      }}
      className={cx(
        "ltr rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs text-fg-2",
        pending && "opacity-60",
      )}
    />
  );
}
