"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { keepJobMoving } from "@/app/actions";

/** Refreshes the page while a job runs and keeps the serverless drain going. */
export function AutoRefresh({ active, seconds = 4 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let ticks = 0;
    const id = setInterval(() => {
      ticks++;
      // Nudge processing every ~30s; a drain already running in this instance is skipped.
      if (ticks % Math.ceil(30 / seconds) === 1) void keepJobMoving();
      router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [active, seconds, router]);
  return null;
}
