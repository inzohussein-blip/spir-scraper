import type { ComponentProps, ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Card with an optional coloured icon square in the header, as in the Spir bot panel. */
export function Card({
  title,
  description,
  icon,
  children,
  actions,
  className,
  flush,
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={cx("card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-[18px] pt-3.5 pb-3">
          {icon && (
            <span className="grid size-[34px] place-items-center rounded-[10px] bg-accent-soft text-accent">
              <Icon name={icon} />
            </span>
          )}
          <div className="min-w-40 flex-1">
            {title && <h2 className="text-[15px]">{title}</h2>}
            {description && <p className="text-[12.5px] text-muted">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={flush ? "" : "px-[18px] pt-4 pb-[18px]"}>{children}</div>
    </section>
  );
}

const btnBase =
  "inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-[10px] border px-3.5 py-2 text-sm font-medium transition active:translate-y-px disabled:cursor-default disabled:opacity-50";
const btnVariants = {
  primary: "border-accent bg-accent text-accent-text hover:brightness-105",
  default: "border-line bg-surface hover:border-line-strong hover:bg-surface-2",
  ghost: "border-transparent bg-transparent hover:bg-surface-2",
  danger: "border-line bg-surface text-bad hover:bg-bad-soft",
};

export function Button({
  variant = "primary",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof btnVariants }) {
  return <button className={cx(btnBase, btnVariants[variant], className)} {...props} />;
}

export function LinkButton({ className, ...props }: ComponentProps<"a">) {
  return <a className={cx(btnBase, btnVariants.default, className)} {...props} />;
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
      <span className="text-sm font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-3 focus:ring-accent-soft";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cx(inputClass, className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cx(inputClass, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cx(inputClass, className)} rows={4} {...props} />;
}

type Tone = "ok" | "warn" | "bad" | "info" | "accent" | "plain";
const TONES: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent",
  plain: "bg-bg-2 text-fg-2",
};

/** Pill badge with a coloured dot. */
export function Badge({
  tone = "plain",
  dot = true,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold",
        TONES[tone],
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current opacity-90" />}
      {children}
    </span>
  );
}

const STATUS: Record<string, [string, Tone]> = {
  queued: ["في الطابور", "plain"],
  running: ["قيد التشغيل", "warn"],
  done: ["اكتملت", "ok"],
  failed: ["فشلت", "bad"],
  cancelled: ["أُلغيت", "plain"],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, "plain"];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Dot({
  tone = "plain",
  pulse,
}: {
  tone?: "ok" | "warn" | "bad" | "plain";
  pulse?: boolean;
}) {
  const c = {
    ok: "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]",
    warn: "bg-warn shadow-[0_0_0_3px_var(--warn-soft)]",
    bad: "bg-bad shadow-[0_0_0_3px_var(--bad-soft)]",
    plain: "bg-muted",
  }[tone];
  return <span className={cx("inline-block size-2 shrink-0 rounded-full", c, pulse && "pulse")} />;
}

export function Progress({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-bg-2"
      role="progressbar"
      aria-valuenow={pct}
    >
      <div
        className="h-full rounded-full bg-gradient-to-l from-accent to-accent-2 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** KPI tile. */
export function Kpi({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between text-[12.5px] text-muted">
        {label}
        {icon && <Icon name={icon} className="size-4 text-accent" />}
      </div>
      <div className="mt-1.5 text-2xl font-bold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-line bg-surface-2 p-3">
      <div className="text-xs text-muted">{label}</div>
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
    info: "border-info/25 bg-info-soft text-info",
    warn: "border-warn/25 bg-warn-soft text-warn",
    error: "border-bad/25 bg-bad-soft text-bad",
    ok: "border-ok/25 bg-ok-soft text-ok",
  }[tone];
  return <div className={cx("rounded-[10px] border px-4 py-3 text-sm", cls)}>{children}</div>;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-[12.5px] text-muted">
            {head.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static header cells
              <th key={i} className="px-2 py-2 text-start font-medium first:ps-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:px-2 [&_td]:py-2.5 [&_td:first-child]:ps-0 [&_tr]:border-b [&_tr]:border-line [&_tr:last-child]:border-0">
          {children}
        </tbody>
      </table>
    </div>
  );
}

export const fmtDate = (d: Date | string | null) =>
  d
    ? new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d))
    : "—";

export const fmtAgo = (d: Date | string) => {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("ar", { numeric: "auto" });
  if (s < 60) return rtf.format(-s, "second");
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86400), "day");
};

export const fmtNum = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("ar").format(n);
