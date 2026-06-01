// Pure helpers for the harness, extracted so they can be unit-tested without a
// browser or Supabase connection.
import type { ScrapeWrite, SourceId } from "@optionpilot/contracts";

// Public, no-login sources only.
export const PUBLIC_PER_SYMBOL: SourceId[] = ["finviz", "yahoo_options", "yahoo_analysis"];
export const PUBLIC_MACRO: SourceId[] = ["fred_t10y2y", "fred_hyoas", "yahoo_vix", "finviz_spy"];

export interface Job {
  source: SourceId;
  symbol?: string;
}

export interface PlanOpts {
  symbols: string[];
  macro: boolean;
  macroOnly: boolean;
}

// Build the job list: macro once, then each public per-symbol source per symbol.
export function planJobs(opts: PlanOpts): Job[] {
  const jobs: Job[] = [];
  if (opts.macro) for (const s of PUBLIC_MACRO) jobs.push({ source: s });
  if (!opts.macroOnly) for (const sym of opts.symbols) for (const s of PUBLIC_PER_SYMBOL) jobs.push({ source: s, symbol: sym });
  return jobs;
}

// Distinct, uppercased, non-empty symbols (order preserved).
export function dedupeSymbols(values: (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const v of values) {
    const s = v?.trim().toUpperCase();
    if (s) set.add(s);
  }
  return [...set];
}

export interface PersistOp {
  table: "macro_data" | "stocks";
  row: Record<string, unknown>;
  onConflict: string;
}

// Map a parser write to the Supabase upsert it should perform. Mirrors the
// extension's scrapeCore.persistWrite so harness and extension stay identical.
export function buildPersistOp(write: ScrapeWrite, nowIso: string): PersistOp {
  if (write.kind === "macro") {
    return {
      table: "macro_data",
      row: { metric: write.metric, value: write.value, as_of: write.asOf ?? null, updated_at: nowIso },
      onConflict: "metric",
    };
  }
  if (write.kind === "stock_intrinsic") {
    return {
      table: "stocks",
      row: { symbol: write.symbol.toUpperCase(), intrinsic_value: write.value, intrinsic_updated_at: nowIso },
      onConflict: "symbol",
    };
  }
  const row: Record<string, unknown> = { symbol: write.symbol.toUpperCase() };
  row[write.column] = write.data;
  row[`${write.column}_updated_at`] = nowIso;
  return { table: "stocks", row, onConflict: "symbol" };
}
