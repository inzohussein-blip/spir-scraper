import type { ComponentProps, ReactNode } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export function Card({
  title,
  children,
  actions,
}: {
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-sm">
      {(title || actions) && (
        <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: "primary" | "ghost" | "danger" }) {
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50",
        variant === "primary" && "bg-brand text-white hover:opacity-90",
        variant === "ghost" && "border border-[var(--line)] hover:bg-brand-soft hover:text-brand",
        variant === "danger" && "border border-red-300 text-red-600 hover:bg-red-50",
        className,
      )}
      {...props}
    />
  );
}

export function LinkButton({ className, ...props }: ComponentProps<"a">) {
  return (
    <a
      className={cx(
        "inline-flex items-center justify-center rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium hover:bg-brand-soft hover:text-brand",
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--muted)]">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cx(inputClass, className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cx(inputClass, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cx(inputClass, className)} rows={4} {...props} />;
}

const STATUS: Record<string, [string, string]> = {
  queued: ["في الطابور", "bg-slate-100 text-slate-700"],
  running: ["قيد التشغيل", "bg-amber-100 text-amber-800"],
  done: ["اكتملت", "bg-emerald-100 text-emerald-800"],
  failed: ["فشلت", "bg-red-100 text-red-700"],
  cancelled: ["أُلغيت", "bg-slate-200 text-slate-600"],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, cls] = STATUS[status] ?? [status, "bg-slate-100"];
  return <span className={cx("rounded-full px-2.5 py-0.5 text-xs font-medium", cls)}>{label}</span>;
}

export function Progress({ value }: { value: number }) {
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-[var(--line)]"
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
    >
      <div
        className="h-full bg-brand transition-all"
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--line)] p-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error" | "ok";
  children: ReactNode;
}) {
  const cls = {
    info: "border-blue-200 bg-blue-50 text-blue-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-red-200 bg-red-50 text-red-800",
    ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tone];
  return <div className={cx("rounded-lg border px-4 py-3 text-sm", cls)}>{children}</div>;
}

export const fmtDate = (d: Date | string | null) =>
  d
    ? new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d))
    : "—";
export const fmtNum = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("ar").format(n);
