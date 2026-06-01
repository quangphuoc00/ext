// Small presentational primitives shared across dashboard panels.

import type { ReactNode, SVGProps } from "react";
import { relativeTime } from "./format";

// ---- Card ------------------------------------------------------------------

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  // Disable inner padding for full-bleed contents (e.g. tables, lists that
  // already manage their own row padding).
  padded?: boolean;
}) {
  return (
    <section
      className={`overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-card transition-shadow hover:shadow-card-hover dark:border-neutral-800/80 dark:bg-neutral-900/80 ${
        className ?? ""
      }`}
    >
      {(title || actions || subtitle) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3.5 dark:border-neutral-800/80">
          <div className="min-w-0">
            {title && (
              <h2 className="truncate text-sm font-semibold tracking-tight text-neutral-800 dark:text-neutral-100">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}

// ---- Badge -----------------------------------------------------------------

type Tone = "neutral" | "green" | "red" | "amber" | "blue" | "brand";

const toneClasses: Record<Tone, string> = {
  neutral:
    "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  green:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  red: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  brand: "bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${toneClasses[tone]} ${
        className ?? ""
      }`}
    >
      {children}
    </span>
  );
}

// Colored dot, used for regime indicators and status markers.
export function Dot({
  tone = "neutral",
  className,
}: {
  tone?: Tone;
  className?: string;
}) {
  const dotClasses: Record<Tone, string> = {
    neutral: "bg-neutral-400 dark:bg-neutral-500",
    green: "bg-emerald-500",
    red: "bg-red-500",
    amber: "bg-amber-500",
    blue: "bg-blue-500",
    brand: "bg-brand-500",
  };
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 rounded-full ${dotClasses[tone]} ${className ?? ""}`}
    />
  );
}

// ---- UpdatedBadge / StatusBadge -------------------------------------------

// Relative "last updated" badge. Gray when the timestamp is null/unknown.
export function UpdatedBadge({
  at,
  label,
}: {
  at: string | null | undefined;
  label: string;
}) {
  const rel = relativeTime(at);
  return (
    <span
      title={at ?? "no data"}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
        rel
          ? "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
          : "bg-neutral-100 text-neutral-300 dark:bg-neutral-800/60 dark:text-neutral-600"
      }`}
    >
      <span className="uppercase tracking-wide">{label}</span>
      <span>{rel ?? "—"}</span>
    </span>
  );
}

const requestTone: Record<string, Tone> = {
  pending: "amber",
  running: "blue",
  done: "green",
  error: "red",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={requestTone[status] ?? "neutral"}>
      <Dot tone={requestTone[status] ?? "neutral"} />
      {status}
    </Badge>
  );
}

// ---- Skeleton --------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={`block animate-shimmer rounded-md bg-[linear-gradient(90deg,theme(colors.neutral.200)_0%,theme(colors.neutral.100)_50%,theme(colors.neutral.200)_100%)] bg-[length:200%_100%] dark:bg-[linear-gradient(90deg,theme(colors.neutral.800)_0%,theme(colors.neutral.700)_50%,theme(colors.neutral.800)_100%)] ${
        className ?? ""
      }`}
    />
  );
}

// ---- Buttons ---------------------------------------------------------------

type ButtonTone = "primary" | "secondary" | "ghost" | "success" | "danger";

const buttonClasses: Record<ButtonTone, string> = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-500 active:bg-brand-700 disabled:opacity-50",
  secondary:
    "border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800",
  ghost:
    "text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800",
  success:
    "bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50",
  danger:
    "bg-red-600 text-white hover:bg-red-500 active:bg-red-700 disabled:opacity-50",
};

export function Button({
  tone = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  size?: "sm" | "md";
}) {
  const sizeClasses = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm";
  return (
    <button
      type={props.type ?? "button"}
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors ${sizeClasses} ${buttonClasses[tone]} ${
        className ?? ""
      }`}
    />
  );
}

export function IconButton({
  label,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={props.type ?? "button"}
      aria-label={label}
      title={label}
      {...props}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 ${
        className ?? ""
      }`}
    />
  );
}

// ---- Icons (lightweight inline SVG) ---------------------------------------

type IconProps = SVGProps<SVGSVGElement>;

function svg(props: IconProps, path: ReactNode) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {path}
    </svg>
  );
}

export const Icon = {
  X: (p: IconProps) => svg(p, <><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>),
  Plus: (p: IconProps) => svg(p, <><path d="M12 5v14" /><path d="M5 12h14" /></>),
  Edit: (p: IconProps) =>
    svg(
      p,
      <>
        <path d="M11 4H4v16h16v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </>,
    ),
  Trash: (p: IconProps) =>
    svg(
      p,
      <>
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      </>,
    ),
  Refresh: (p: IconProps) =>
    svg(
      p,
      <>
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 4v5h-5" />
      </>,
    ),
  External: (p: IconProps) =>
    svg(
      p,
      <>
        <path d="M14 5h5v5" />
        <path d="M19 5L10 14" />
        <path d="M19 13v6H5V5h6" />
      </>,
    ),
  ChevronDown: (p: IconProps) => svg(p, <path d="M6 9l6 6 6-6" />),
  Check: (p: IconProps) => svg(p, <path d="M5 12l5 5L20 7" />),
  Logo: (p: IconProps) =>
    svg(
      { ...p, strokeWidth: 1.6 },
      <>
        <path d="M3 17l6-6 4 4 8-9" />
        <path d="M14 6h7v7" />
      </>,
    ),
};

// ---- Stat ------------------------------------------------------------------

// Compact label + value pair used inside watchlist rows and summaries.
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "positive" | "negative" | "muted";
}) {
  const valueTone =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "negative"
        ? "text-red-600 dark:text-red-400"
        : tone === "muted"
          ? "text-neutral-400 dark:text-neutral-500"
          : "text-neutral-900 dark:text-neutral-100";
  return (
    <div className="min-w-[68px]">
      <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {label}
      </div>
      <div className={`num text-sm font-semibold ${valueTone}`}>{value}</div>
      {hint && (
        <div className="text-[10px] text-neutral-400 dark:text-neutral-500">{hint}</div>
      )}
    </div>
  );
}

// ---- SegmentedControl ------------------------------------------------------

export function SegmentedControl<V extends string>({
  value,
  onChange,
  options,
  size = "sm",
}: {
  value: V;
  onChange: (next: V) => void;
  options: { value: V; label: string }[];
  size?: "sm" | "md";
}) {
  const padding = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm";
  return (
    <div
      role="tablist"
      className="inline-flex rounded-md border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-900"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`rounded font-medium transition-colors ${padding} ${
              active
                ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-50"
                : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
