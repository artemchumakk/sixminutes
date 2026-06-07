import type { ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function StatusDot({
  tone = "ok",
  pulse = false,
}: {
  tone?: "ok" | "warn" | "crit" | "idle";
  pulse?: boolean;
}) {
  const color =
    tone === "ok" ? "#16a34a" : tone === "warn" ? "#d97706" : tone === "crit" ? "#dc2626" : "#a3a3a3";
  return (
    <span className="relative inline-flex h-2 w-2">
      {pulse && (
        <span
          className="absolute inline-flex h-full w-full rounded-full"
          style={{ background: color, animation: "pulse-ring 1.8s ease-out infinite" }}
        />
      )}
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: color }} />
    </span>
  );
}

export function Panel({
  title,
  right,
  children,
  className,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("flex flex-col rounded-2xl border border-neutral-200 bg-white", className)}>
      {title && (
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-neutral-700">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  unit,
  tone,
  sub,
}: {
  label: string;
  value: string | number;
  unit?: string;
  tone?: "ok" | "warn" | "crit";
  sub?: string;
}) {
  const color =
    tone === "ok"
      ? "text-green-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "crit"
          ? "text-red-600"
          : "text-neutral-900";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{label}</span>
      <span className={cx("font-mono text-xl tabular-nums", color)}>
        {value}
        {unit && <span className="ml-0.5 text-xs text-neutral-400">{unit}</span>}
      </span>
      {sub && <span className="text-[11px] text-neutral-400">{sub}</span>}
    </div>
  );
}

export function Pill({
  children,
  tone = "idle",
}: {
  children: ReactNode;
  tone?: "ok" | "warn" | "crit" | "idle" | "accent";
}) {
  const map: Record<string, string> = {
    ok: "border-green-200 bg-green-50 text-green-700",
    warn: "border-amber-200 bg-amber-50 text-amber-700",
    crit: "border-red-200 bg-red-50 text-red-700",
    idle: "border-neutral-200 bg-neutral-50 text-neutral-500",
    accent: "border-violet-200 bg-violet-50 text-violet-600",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        map[tone]
      )}
    >
      {children}
    </span>
  );
}

export function fmtSec(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}
