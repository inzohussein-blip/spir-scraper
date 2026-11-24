"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { keepJobMoving } from "@/app/actions";

/**
 * Refreshes the page while a job runs and keeps the serverless drain going.
 * Each refresh is a server render with database queries, so it runs every
 * 15 seconds, pauses while the tab is hidden (another tab, phone locked),
 * and stops after 20 minutes on the page (free plans count every wake-up;
 * the daily maintenance finishes what is left).
 */
export function AutoRefresh({ active, seconds = 15 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let ticks = 0;
    const until = Date.now() + 20 * 60_000;
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() > until) return;
      ticks++;
      // Nudge processing every ~30s; a drain already running in this instance is skipped.
      if (ticks % Math.ceil(30 / seconds) === 1) void keepJobMoving();
      router.refresh();
    };
    const id = setInterval(tick, seconds * 1000);
    const onShow = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [active, seconds, router]);
  return null;
}
