"use client";

import { useMemo, useRef, useState } from "react";
import { createClient } from "./lib/db";
import { relativeTime } from "./lib/format";
import { Icon } from "./lib/ui";

const DEV_EMAIL = "ddqphuoc@gmail.com";

export default function DiagnosticsPanel({ email }: { email: string | null }) {
  if (email !== DEV_EMAIL) return null;
  return <CopyDiagnosticsMenuItem />;
}

function CopyDiagnosticsMenuItem() {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<"idle" | "loading" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copyDiagnostics() {
    setState("loading");
    const [scrapeRes, analysisRes, stocksRes] = await Promise.all([
      supabase
        .from("scrape_requests")
        .select("*")
        .order("requested_at", { ascending: false })
        .limit(20),
      supabase
        .from("analysis_requests")
        .select("*")
        .order("requested_at", { ascending: false })
        .limit(20),
      supabase
        .from("stocks")
        .select(
          "symbol, yahoo_options_updated_at, optioncharts_updated_at, yahoo_analysis_updated_at, finviz_updated_at, intrinsic_updated_at, updated_at",
        )
        .order("symbol", { ascending: true }),
    ]);

    const scrape = scrapeRes.data ?? [];
    const analysis = analysisRes.data ?? [];
    const stocks = stocksRes.data ?? [];

    const text = [
      `=== OptionPilot Dashboard Diagnostics ===`,
      `capturedAt: ${new Date().toISOString()}`,
      ``,
      `--- SCRAPE REQUESTS (last ${scrape.length}) ---`,
      ...scrape.map(
        (r) =>
          `[${r.status.toUpperCase()}] ${r.id}` +
          `  requested=${r.requested_at}` +
          (r.completed_at ? `  completed=${r.completed_at}` : "") +
          (r.error ? `  error=${r.error}` : ""),
      ),
      ``,
      `--- ANALYSIS REQUESTS (last ${analysis.length}) ---`,
      ...analysis.map(
        (r) =>
          `[${r.status.toUpperCase()}] ${r.symbol} (${r.mode ?? "?"})  ${r.id}` +
          `  requested=${r.requested_at}` +
          (r.completed_at ? `  completed=${r.completed_at}` : "") +
          (r.error ? `  error=${r.error}` : ""),
      ),
      ``,
      `--- STOCKS DATA FRESHNESS ---`,
      ...stocks.map(
        (s) =>
          `${s.symbol}` +
          `  yahoo_options=${relativeTime(s.yahoo_options_updated_at) ?? "-"}` +
          `  optioncharts=${relativeTime(s.optioncharts_updated_at) ?? "-"}` +
          `  yahoo_analysis=${relativeTime(s.yahoo_analysis_updated_at) ?? "-"}` +
          `  finviz=${relativeTime(s.finviz_updated_at) ?? "-"}` +
          `  intrinsic=${relativeTime(s.intrinsic_updated_at) ?? "-"}`,
      ),
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("error");
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }

  const label =
    state === "loading"
      ? "Loading…"
      : state === "copied"
        ? "Copied to clipboard"
        : state === "error"
          ? "Copy failed"
          : "Copy diagnostics";

  return (
    <button
      type="button"
      onClick={() => void copyDiagnostics()}
      disabled={state === "loading"}
      className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-200 dark:hover:bg-neutral-800"
    >
      <span>{label}</span>
      {state === "copied" ? (
        <Icon.Check width={14} height={14} className="text-emerald-500" />
      ) : (
        <Icon.External width={14} height={14} className="text-neutral-400" />
      )}
    </button>
  );
}
