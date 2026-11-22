"use client";

import { useEffect, useState } from "react";

type Meta = { version: string; builtAt: string; bytes: number };

/** Version and build date of the extension zip the Vercel build placed in /downloads. */
export function ExtensionBuildInfo() {
  const [meta, setMeta] = useState<Meta | null | "missing">(null);
  useEffect(() => {
    fetch("/downloads/spir-extension.json", { cache: "no-store" })
      .then(async (r): Promise<Meta | "missing"> => (r.ok ? ((await r.json()) as Meta) : "missing"))
      .then((m) => setMeta(m))
      .catch(() => setMeta("missing"));
  }, []);
  if (meta === null) return <span className="text-muted">…</span>;
  if (meta === "missing")
    return (
      <span className="text-bad">
        لم تُبنَ الإضافة في هذا النشر. تُبنى مع كل نشر على Vercel؛ أعد النشر إن لم تظهر.
      </span>
    );
  return (
    <span className="text-muted">
      الإصدار <span className="ltr font-medium text-fg">{meta.version}</span> · بُنيت{" "}
      {new Date(meta.builtAt).toLocaleString("ar")} · {Math.round(meta.bytes / 1024)} KB
    </span>
  );
}

/** A value with a copy button (chrome:// links cannot be opened from a web page). */
export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <code className="ltr rounded-md bg-surface-2 px-2 py-0.5 text-[13px]">{text}</code>
      <button
        type="button"
        className="text-[12.5px] text-accent hover:underline"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "نُسخ ✓" : "نسخ"}
      </button>
    </span>
  );
}
