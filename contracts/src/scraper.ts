// Frozen scraper contract shared by the extension engine and all parser modules.
// Each parser is a pure function (document) => ScrapeWrite | null.

// ---- Source identifiers -----------------------------------------------------

export const PER_SYMBOL_SOURCES = [
  "yahoo_options",
  "optioncharts",
  "yahoo_analysis",
  "finviz",
  "stockoracle",
] as const;
export type PerSymbolSource = (typeof PER_SYMBOL_SOURCES)[number];

export const MACRO_SOURCES = [
  "fred_t10y2y",
  "fred_hyoas",
  "yahoo_vix",
  "finviz_spy",
] as const;
export type MacroSource = (typeof MACRO_SOURCES)[number];

export type SourceId = PerSymbolSource | MacroSource;

export type MacroMetric = "t10y2y" | "hy_oas" | "vix" | "spy_sma200";

// Stocks columns that hold a raw JSON blob from a parser.
export type StockJsonColumn =
  | "yahoo_options"
  | "optioncharts"
  | "yahoo_analysis"
  | "finviz";

// ---- Per-source field shapes (stored in stocks.<source> jsonb) --------------

export interface OptionQuote {
  strike: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null; // implied volatility as a fraction (0.21 = 21%)
}

export interface YahooOptionsExpiration {
  expiry: string; // ISO date
  puts: OptionQuote[];
}

// Yahoo's `marketState` field on the quote response. We persist it so the
// prompt builder can refuse to evaluate a chain that was snapshot while the
// market was closed (bid/ask/OI all zero) instead of treating those zeros as
// real quotes. "UNKNOWN" means the parser didn't find the field on the page;
// callers should treat it the same as "REGULAR" (don't FAIL on missing data).
export type YahooMarketState =
  | "REGULAR"
  | "PRE"
  | "POST"
  | "CLOSED"
  | "UNKNOWN";

export interface YahooOptionsData {
  price: number | null;
  expirations: YahooOptionsExpiration[];
  // Optional so existing persisted rows (written before this field was
  // introduced) deserialize cleanly. New parses always populate it.
  marketState?: YahooMarketState;
}

export interface OptionGreek {
  expiry: string;
  strike: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
}

export interface OptionchartsData {
  ivRank: number | null; // percent (28.51 = 28.51%)
  ivPercentile: number | null;
  iv30d: number | null;
  expectedMove: number | null;
  putCallRatio: number | null;
  greeks: OptionGreek[];
  // True when the page is showing the "Upgrade to unlock this feature"
  // interstitial in place of the per-strike chain. Lets downstream code
  // (and the diagnostics summary) distinguish "premium gated, greeks
  // intentionally empty" from "parser miss".
  greeksPaywalled?: boolean;
}

export interface EstimatePeriod {
  period: string; // e.g. "Current Year (2026)"
  numAnalysts: number | null;
  avgEstimate: number | null;
  lowEstimate: number | null;
  highEstimate: number | null;
}

export interface YahooAnalysisData {
  revenueEstimate: EstimatePeriod[];
  epsEstimate: EstimatePeriod[];
  epsRevisions: {
    up7: number | null;
    up30: number | null;
    down7: number | null;
    down30: number | null;
  };
}

export interface FinvizData {
  price: number | null;
  marketCap: number | null; // in dollars
  beta: number | null;
  debtEq: number | null;
  shortFloat: number | null; // percent
  avgVolume: number | null;
  volume: number | null;
  rsi14: number | null;
  sma20: number | null; // percent relative (e.g. +0.97)
  sma50: number | null;
  sma200: number | null;
  high52w: number | null; // percent relative
  low52w: number | null;
  earningsDate: string | null;
  sector: string | null;
  industry: string | null;
  epsTtm: number | null;
  roe: number | null; // percent
  pe: number | null;
}

// Map a JSON column to its parsed shape.
export interface StockJsonShapes {
  yahoo_options: YahooOptionsData;
  optioncharts: OptionchartsData;
  yahoo_analysis: YahooAnalysisData;
  finviz: FinvizData;
}

// ---- Parser output ----------------------------------------------------------

export type ScrapeWrite =
  | { kind: "stock_json"; symbol: string; column: StockJsonColumn; data: Record<string, unknown> }
  | { kind: "stock_intrinsic"; symbol: string; value: number }
  | { kind: "macro"; metric: MacroMetric; value: number; asOf?: string };

export interface ParseContext {
  symbol?: string; // the symbol being scraped (for per-symbol sources)
}

// A parser reads the current page DOM and returns what to persist (or null).
export type Parser = (doc: Document, ctx: ParseContext) => ScrapeWrite | null;

// ---- Jobs (what the orchestrator opens) -------------------------------------

export interface ScrapeJob {
  id: string; // unique per run, e.g. `${source}:${symbol ?? ""}`
  source: SourceId;
  symbol?: string; // present for per-symbol sources
  url: string;
}

export function isPerSymbolSource(s: SourceId): s is PerSymbolSource {
  return (PER_SYMBOL_SOURCES as readonly string[]).includes(s);
}

// ---- URL builders ----------------------------------------------------------

export function buildUrl(source: SourceId, symbol?: string): string {
  const sym = (symbol ?? "").toUpperCase();
  switch (source) {
    case "yahoo_options":
      return `https://ca.finance.yahoo.com/quote/${sym}/options/`;
    case "optioncharts":
      // The overview page is free and exposes IV stats, put/call volume, and the
      // calls+puts greeks chain. The dedicated option-chain view is paywalled.
      return `https://optioncharts.io/options/${sym}`;
    case "yahoo_analysis":
      return `https://ca.finance.yahoo.com/quote/${sym}/analysis/`;
    case "finviz":
      return `https://finviz.com/quote.ashx?t=${sym}`;
    case "stockoracle":
      return `https://app.stockoracle.com/stock-details/${sym}/overview`;
    case "fred_t10y2y":
      return "https://fred.stlouisfed.org/series/T10Y2Y";
    case "fred_hyoas":
      return "https://fred.stlouisfed.org/series/BAMLH0A0HYM2";
    case "yahoo_vix":
      return "https://ca.finance.yahoo.com/quote/%5EVIX";
    case "finviz_spy":
      return "https://finviz.com/quote.ashx?t=SPY";
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

// Host match patterns -> which source a content script should run as.
// Used by the registry to dispatch the right parser on a given tab.
export function sourceForUrl(url: string): SourceId | null {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname;
    if (host.includes("optioncharts.io")) return "optioncharts";
    if (host.includes("stockoracle.com")) return "stockoracle";
    if (host.includes("fred.stlouisfed.org")) {
      if (path.includes("T10Y2Y")) return "fred_t10y2y";
      if (path.includes("BAMLH0A0HYM2")) return "fred_hyoas";
      return null;
    }
    if (host.includes("finviz.com")) {
      const t = u.searchParams.get("t");
      return t && t.toUpperCase() === "SPY" ? "finviz_spy" : "finviz";
    }
    if (host.includes("finance.yahoo.com")) {
      if (path.includes("%5EVIX") || path.includes("^VIX")) return "yahoo_vix";
      if (path.includes("/analysis")) return "yahoo_analysis";
      if (path.includes("/options")) return "yahoo_options";
      return null;
    }
    return null;
  } catch {
    return null;
  }
}
