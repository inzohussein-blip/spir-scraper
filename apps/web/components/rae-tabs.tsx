"use client";

import { useEffect, useState } from "react";
import { RaeApp } from "./rae-app";
import { RaeRelay } from "./rae-relay";
import { cx } from "./ui";

const TABS = [
  {
    id: "local",
    label: "محلي",
    hint: "من هذه النافذة على جهازك · صفر استهلاك",
  },
  {
    id: "relay",
    label: "عبر claude.ai · ntfy",
    hint: "من Claude في أي متصفح أو الهاتف · شبه صفر",
  },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** The two ways to use reverse-api-engineer, as two windows inside the window. */
export function RaeTabs() {
  const [tab, setTab] = useState<Tab>("local");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("spir-rae-tab");
      if (saved === "relay" || saved === "local") setTab(saved);
    } catch {
      // storage blocked
    }
  }, []);
  const pick = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem("spir-rae-tab", t);
    } catch {
      // storage blocked
    }
  };

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="طريقة العمل" className="grid gap-2 sm:grid-cols-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => pick(t.id)}
            className={cx(
              "rounded-xl border p-3 text-start transition",
              tab === t.id
                ? "border-accent bg-accent-soft"
                : "border-line bg-surface hover:bg-surface-2",
            )}
          >
            <span className={cx("block font-semibold", tab === t.id && "text-accent")}>
              {t.label}
            </span>
            <span className="block text-xs text-muted">{t.hint}</span>
          </button>
        ))}
      </div>
      {tab === "local" ? (
        <div role="tabpanel" aria-label="محلي" className="space-y-4">
          <div className="card space-y-1.5 p-4 text-sm text-fg-2">
            <div className="font-semibold text-fg">كيف تعمل هذه الطريقة</div>
            <p>
              هذه النافذة تكلّم الجسر على جهازك مباشرة (127.0.0.1)، والجسر يشغّل reverse-api-engineer
              محلياً. لا يمر أي طلب بخوادم المنصة، فالاستهلاك صفر. تعمل فقط من الكمبيوتر الذي يشغّل
              الجسر. ومن Claude Desktop أو Claude Code على نفس الجهاز عبر MCP محلي (البطاقة في
              الأسفل).
            </p>
          </div>
          <RaeApp />
        </div>
      ) : (
        <div role="tabpanel" aria-label="عبر claude.ai">
          <RaeRelay />
        </div>
      )}
    </div>
  );
}
