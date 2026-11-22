"use client";

import { useEffect, useState } from "react";
import { Button } from "./ui";

const toKey = (base64: string) => {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

/** "Enable on this device": browser push for dashboard notifications. */
export function PushToggle({ publicKey }: { publicKey: string }) {
  const [state, setState] = useState<"unsupported" | "off" | "on" | "busy" | "denied">("busy");

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window))
      return setState("unsupported");
    if (Notification.permission === "denied") return setState("denied");
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? "on" : "off"))
      .catch(() => setState("unsupported"));
  }, []);

  async function enable() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toKey(publicKey),
      });
      const res = await fetch("/api/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      setState(res.ok ? "on" : "off");
    } catch {
      setState(Notification.permission === "denied" ? "denied" : "off");
    }
  }

  async function disable() {
    setState("busy");
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
    setState("off");
  }

  if (state === "unsupported")
    return (
      <p className="text-xs text-muted">
        هذا المتصفح لا يدعم الإشعارات. على آيفون: أضف اللوحة للشاشة الرئيسية أولاً.
      </p>
    );
  if (state === "denied")
    return <p className="text-xs text-warn">الإشعارات محظورة لهذا الموقع من إعدادات المتصفح.</p>;
  return state === "on" ? (
    <Button variant="default" onClick={disable}>
      أطفئ الإشعارات على هذا الجهاز
    </Button>
  ) : (
    <Button variant="default" onClick={enable} disabled={state === "busy"}>
      فعّل الإشعارات على هذا الجهاز
    </Button>
  );
}
