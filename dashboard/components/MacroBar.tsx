"use client";

import { useEffect, useMemo, useState } from "react";
import type { Database } from "@optionpilot/contracts";
import { createClient } from "./lib/db";
import { formatNumber, relativeTime, useNow } from "./lib/format";
import { Dot, Skeleton } from "./lib/ui";

type MacroRow = Database["public"]["Tables"]["macro_data"]["Row"];

type Regime = "calm" | "normal" | "stress" | "neutral";

const regimeTone: Record<Regime, "green" | "neutral" | "amber" | "red"> = {
  calm: "green",
  normal: "neutral",
  stress: "red",
  neutral: "neutral",
};

interface MetricSpec {
  metric: string;
  label: string;
  description: string;
  fractionDigits: number;
  // Returns regime + a one-word reading for the current value.
  classify: (value: number) => { regime: Regime; reading: string };
}

const METRICS: MetricSpec[] = [
  {
    metric: "vix",
    label: "VIX",
    description: "Equity volatility",
    fractionDigits: 2,
    classify: (v) =>
      v < 15
        ? { regime: "calm", reading: "Calm" }
        : v < 25
          ? { regime: "normal", reading: "Normal" }
          : { regime: "stress", reading: "Stressed" },
  },
  {
    metric: "t10y2y",
    label: "10y – 2y",
    description: "Yield curve",
    fractionDigits: 2,
    classify: (v) =>
      v < 0
        ? { regime: "stress", reading: "Inverted" }
        : v < 0.5
          ? { regime: "normal", reading: "Flat" }
          : { regime: "calm", reading: "Steep" },
  },
  {
    metric: "hy_oas",
    label: "HY OAS",
    description: "Credit spread",
    fractionDigits: 2,
    classify: (v) =>
      v < 4
        ? { regime: "calm", reading: "Tight" }
        : v < 6
          ? { regime: "normal", reading: "Normal" }
          : { regime: "stress", reading: "Wide" },
  },
  {
    metric: "spy_sma200",
    label: "SPY 200SMA",
    description: "Long-term trend",
    fractionDigits: 2,
    classify: () => ({ regime: "neutral", reading: "Trend" }),
  },
];

export default function MacroBar() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Record<string, MacroRow>>({});
  const [loaded, setLoaded] = useState(false);
  useNow(60_000);

  useEffect(() => {
    let active = true;
    void supabase
      .from("macro_data")
      .select("*")
      .then(({ data }) => {
        if (!active) return;
        if (data) {
          const next: Record<string, MacroRow> = {};
          for (const row of data) next[row.metric] = row;
          setRows(next);
        }
        setLoaded(true);
      });

    const channel = supabase
      .channel("macro-data")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "macro_data" },
        (payload) => {
          const row = payload.new;
          if (!row || !("metric" in row)) return;
          const macro = row as MacroRow;
          setRows((prev) => ({ ...prev, [macro.metric]: macro }));
        },
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [supabase]);

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {METRICS.map((spec) => {
        const row = rows[spec.metric];
        const value = row?.value ?? null;
        const classified =
          value !== null && Number.isFinite(value) ? spec.classify(value) : null;
        const tone = classified ? regimeTone[classified.regime] : "neutral";
        const accentBar: Record<typeof tone, string> = {
          green: "bg-emerald-500",
          red: "bg-red-500",
          amber: "bg-amber-500",
          neutral: "bg-neutral-300 dark:bg-neutral-700",
        };

        return (
          <div
            key={spec.metric}
            className="group relative overflow-hidden rounded-xl border border-neutral-200/80 bg-white px-3.5 py-3 shadow-card transition-shadow hover:shadow-card-hover dark:border-neutral-800/80 dark:bg-neutral-900/80"
          >
            <span
              aria-hidden
              className={`absolute inset-x-0 top-0 h-0.5 ${accentBar[tone]}`}
            />
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                  {spec.label}
                </div>
                <div className="text-[10px] text-neutral-400">
                  {spec.description}
                </div>
              </div>
              {classified && (
                <div className="flex items-center gap-1 text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
                  <Dot tone={tone} />
                  <span>{classified.reading}</span>
                </div>
              )}
            </div>
            <div className="mt-2 flex items-end justify-between gap-2">
              <div className="num text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                {!loaded ? (
                  <Skeleton className="h-7 w-16" />
                ) : value !== null ? (
                  formatNumber(value, spec.fractionDigits)
                ) : (
                  <span className="text-neutral-400">—</span>
                )}
              </div>
              <div className="text-[10px] text-neutral-400">
                {row ? (relativeTime(row.updated_at) ?? "—") : "no data"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
