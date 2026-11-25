"use client";

import { useEffect } from "react";

/**
 * Registers the service worker on every page, so the installed app shows its
 * offline page without a connection (notifications use the same worker).
 */
export function SwRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Not available (private mode, old browser): the app works without it.
    });
  }, []);
  return null;
}
