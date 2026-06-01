// Owner: Agent D (analysis). Serializes the jsonb columns persisted by the
// scraper (stocks.yahoo_options / optioncharts / yahoo_analysis / finviz) plus
// macro_data rows into compact, human-readable strings for PromptInput.scraped.
// Each formatter is defensive: the inputs are typed as Json, but the live data
// may be partial or malformed, so missing fields render as "?" and an absent /
// empty block returns undefined (buildPrompt then marks it "not available").
import type {
  Json,
  YahooOptionsData,
  YahooOptionsExpiration,
  OptionQuote,
  OptionchartsData,
  YahooAnalysisData,
  FinvizData,
} from "@optionpilot/contracts";

// Caps so a single prompt block stays readable and bounded in size.
const MAX_EXPIRIES = 8;
const MAX_STRIKES = 60;
const MAX_GREEKS = 80;

// Bias the expiry selection toward the trading window this tool actually cares
// about: 20-60 DTE covers the 30-45 DTE entry GATE plus the 21-DTE roll
// trigger. Outside this range we fall back to "nearest expirations first" so
// the block still gives Claude general context.
const TARGET_DTE_MIN = 20;
const TARGET_DTE_MAX = 60;

// Yahoo's options page renders per-strike IV as bucketed powers of two
// (50% / 25% / 12.5% / 6.3% / 3.1% / 1.6% / 0.8% / 0%) for the vast majority
// of strikes. When every value in the rendered chain matches one of these
// buckets, the column is decorative and we strip it from the prompt.
const POW2_IV_BUCKETS = new Set<string>([
  "0.0",
  "0.8",
  "1.6",
  "3.1",
  "6.3",
  "12.5",
  "25.0",
  "50.0",
  "100.0",
]);

export interface MacroRowLike {
  metric: string;
  value: number | null;
  as_of: string | null;
}

function asObject<T>(data: Json | null | undefined): T | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as unknown as T;
  }
  return null;
}

function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || typeof v !== "number" || Number.isNaN(v)) {
    return "?";
  }
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "?" : `${num(v)}%`;
}

// IV is stored as a fraction (0.21 -> 21%).
function ivPct(v: number | null | undefined): string {
  if (v === null || v === undefined || typeof v !== "number" || Number.isNaN(v)) {
    return "?";
  }
  return `${(v * 100).toFixed(1)}%`;
}

function money(v: number | null | undefined): string {
  if (v === null || v === undefined || typeof v !== "number" || Number.isNaN(v)) {
    return "?";
  }
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${num(v)}`;
}

// Calendar days from `from` (YYYY-MM-DD) to `to` (YYYY-MM-DD). Both parsed in
// UTC so DST shifts can't subtract a day. Returns null on unparseable input.
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// Select up to MAX_EXPIRIES expirations, biased to the 20-60 DTE window so the
// 30-45 DTE GATE expiry isn't silently sliced off by a "first N by date" cap.
// Returns the chosen expiries with their computed DTE attached, sorted by
// expiry ascending.
interface SelectedExpiration {
  exp: YahooOptionsExpiration;
  dte: number | null;
}
function selectExpirations(
  expirations: YahooOptionsExpiration[],
  asOfDate: string,
): SelectedExpiration[] {
  const annotated: SelectedExpiration[] = expirations
    .filter((e) => !!e && typeof e.expiry === "string" && Array.isArray(e.puts))
    .map((e) => ({ exp: e, dte: daysBetween(asOfDate, e.expiry) }));

  // Priority 1: every expiry in the target window. These are the ones the
  // checklist directly needs; we never drop them.
  const inWindow = annotated.filter(
    (a) => a.dte != null && a.dte >= TARGET_DTE_MIN && a.dte <= TARGET_DTE_MAX,
  );

  // Priority 2: fill remaining slots with the closest (smallest |DTE|)
  // expirations outside the window, so the prompt still shows surrounding
  // context for liquidity/IV-skew comparisons.
  const outOfWindow = annotated
    .filter((a) => !inWindow.includes(a))
    .sort((a, b) => {
      const da = a.dte == null ? Number.POSITIVE_INFINITY : Math.abs(a.dte);
      const db = b.dte == null ? Number.POSITIVE_INFINITY : Math.abs(b.dte);
      return da - db;
    });

  const chosen = [...inWindow, ...outOfWindow.slice(0, Math.max(0, MAX_EXPIRIES - inWindow.length))];
  // Final ordering: by expiry date ascending so the rendered block reads
  // chronologically (matches how a trader scans an options chain).
  chosen.sort((a, b) => a.exp.expiry.localeCompare(b.exp.expiry));
  return chosen.slice(0, MAX_EXPIRIES);
}

// True when every IV value in the rendered chain falls on one of Yahoo's clean
// powers-of-two buckets. The chain has many strikes, so a single non-bucket IV
// (deep OTM crash hedges often show 300%+) disqualifies the heuristic.
function isPow2BucketedIv(puts: OptionQuote[]): boolean {
  let seen = 0;
  for (const p of puts) {
    if (p.iv == null) continue;
    const key = (p.iv * 100).toFixed(1);
    if (!POW2_IV_BUCKETS.has(key)) return false;
    seen += 1;
  }
  return seen > 0;
}

function isAllZero(values: ReadonlyArray<number | null | undefined>): boolean {
  let seen = 0;
  for (const v of values) {
    if (v == null) continue;
    if (v !== 0) return false;
    seen += 1;
  }
  return seen > 0;
}

function isAllBidAskZero(puts: OptionQuote[]): boolean {
  const bids: (number | null | undefined)[] = [];
  const asks: (number | null | undefined)[] = [];
  for (const p of puts) {
    bids.push(p.bid);
    asks.push(p.ask);
  }
  return isAllZero(bids) && isAllZero(asks);
}

export function formatYahooOptions(
  data: Json | null | undefined,
  asOfDate: string,
): string | undefined {
  const d = asObject<YahooOptionsData>(data);
  if (!d || !Array.isArray(d.expirations) || d.expirations.length === 0) {
    return undefined;
  }
  const selected = selectExpirations(d.expirations, asOfDate);
  if (selected.length === 0) return undefined;

  const out: string[] = [`Underlying price: ${num(d.price)}`];

  // Market state banner. Treat anything non-REGULAR (PRE / POST / CLOSED) as
  // unreliable for bid/ask/OI; also treat the missing-state case as "closed"
  // if every bid+ask in the rendered chain is zero. The prompt's precheck B'
  // converts this banner into a hard FAIL.
  const stateRaw = (d as Partial<YahooOptionsData>).marketState;
  const allBidAskZero = selected.every((s) => isAllBidAskZero(s.exp.puts));
  const effectiveState =
    stateRaw && stateRaw !== "REGULAR"
      ? stateRaw
      : !stateRaw && allBidAskZero
        ? "CLOSED"
        : (stateRaw ?? "REGULAR");
  if (effectiveState !== "REGULAR") {
    out.push(
      `WARNING: snapshot taken while market state = ${effectiveState}. bid/ask/OI are unreliable; precheck B must FAIL.`,
    );
  }

  // Decide once per block whether to strip the IV column (Yahoo bucketed-power-
  // of-two rendering) or the OI column (every value zero across the rendered
  // chain). Per-strike IV unreliability is already covered by prompt rule 4 -
  // stripping the column also saves tokens and reduces LLM confusion.
  const allPuts = selected.flatMap((s) => s.exp.puts.slice(0, MAX_STRIKES));
  const stripIv =
    allPuts.length > 0 &&
    selected.every((s) => isPow2BucketedIv(s.exp.puts.slice(0, MAX_STRIKES)));
  const stripOi = allPuts.length > 0 && isAllZero(allPuts.map((p) => p.openInterest));

  if (stripIv) {
    out.push("Note: per-strike IV unreliable (Yahoo power-of-two buckets); use OptionCharts IV30d.");
  }
  if (stripOi) {
    out.push("Note: per-strike OI unreliable (every value is 0).");
  }

  const headerCols = ["strike", "bid", "ask", "mid", "last", "vol"];
  if (!stripOi) headerCols.push("OI");
  if (!stripIv) headerCols.push("IV");
  const header = `  ${headerCols.join(" | ")}`;

  for (const { exp, dte } of selected) {
    if (exp.puts.length === 0) continue;
    const dteTag = dte == null ? "" : ` (DTE=${dte})`;
    out.push(`Expiry ${exp.expiry}${dteTag} (puts):`);
    out.push(header);
    for (const p of exp.puts.slice(0, MAX_STRIKES)) {
      const cells = [
        num(p.strike),
        num(p.bid),
        num(p.ask),
        num(p.mid),
        num(p.last),
        num(p.volume),
      ];
      if (!stripOi) cells.push(num(p.openInterest));
      if (!stripIv) cells.push(ivPct(p.iv));
      out.push(`  ${cells.join(" | ")}`);
    }
  }
  return out.length > 1 ? out.join("\n") : undefined;
}

export function formatOptioncharts(
  data: Json | null | undefined,
  underlyingPrice?: number | null,
): string | undefined {
  const d = asObject<OptionchartsData>(data);
  if (!d) return undefined;

  // Fallback: when OptionCharts didn't return expectedMove (the tile selector
  // missed, or the value is paywalled), derive a 30-day $-move from the
  // underlying price and IV30d using the same formula the prompt uses for
  // SCORE 8.5. Marked "(computed)" so Claude knows it's derived, not scraped.
  let expectedMove = d.expectedMove;
  let expectedMoveTag = "";
  if (
    expectedMove == null &&
    typeof d.iv30d === "number" &&
    typeof underlyingPrice === "number"
  ) {
    expectedMove = underlyingPrice * d.iv30d * Math.sqrt(30 / 365);
    expectedMoveTag = " (computed: price * iv30d * sqrt(30/365))";
  }

  const out: string[] = [
    `IV Rank: ${num(d.ivRank)}%  IV Percentile: ${num(d.ivPercentile)}%  IV30d: ${num(d.iv30d)}`,
    `Expected move: ${num(expectedMove)}${expectedMoveTag}  Put/Call ratio: ${num(d.putCallRatio)}`,
  ];
  if (Array.isArray(d.greeks) && d.greeks.length > 0) {
    out.push("Greeks (expiry | strike | delta | gamma | theta | vega | IV):");
    for (const g of d.greeks.slice(0, MAX_GREEKS)) {
      out.push(
        `  ${g.expiry} | ${num(g.strike)} | ${num(g.delta, 3)} | ${num(g.gamma, 3)} | ` +
          `${num(g.theta, 3)} | ${num(g.vega, 3)} | ${ivPct(g.iv)}`,
      );
    }
  }
  return out.join("\n");
}

export function formatYahooAnalysis(data: Json | null | undefined): string | undefined {
  const d = asObject<YahooAnalysisData>(data);
  if (!d) return undefined;
  const out: string[] = [];
  if (Array.isArray(d.revenueEstimate) && d.revenueEstimate.length > 0) {
    out.push("Revenue estimates:");
    for (const e of d.revenueEstimate) {
      out.push(
        `  ${e.period}: avg ${num(e.avgEstimate)} (low ${num(e.lowEstimate)}, ` +
          `high ${num(e.highEstimate)}, n=${num(e.numAnalysts)})`,
      );
    }
  }
  if (Array.isArray(d.epsEstimate) && d.epsEstimate.length > 0) {
    out.push("EPS estimates:");
    for (const e of d.epsEstimate) {
      out.push(
        `  ${e.period}: avg ${num(e.avgEstimate)} (low ${num(e.lowEstimate)}, ` +
          `high ${num(e.highEstimate)}, n=${num(e.numAnalysts)})`,
      );
    }
  }
  const r = d.epsRevisions;
  if (r) {
    out.push(
      `EPS revisions: up7=${num(r.up7)} up30=${num(r.up30)} ` +
        `down7=${num(r.down7)} down30=${num(r.down30)}`,
    );
  }
  return out.length > 0 ? out.join("\n") : undefined;
}

// Finviz renders the "Earnings" cell as either an upcoming date ("Aug 5 BMO")
// or - between report and the next quarter being scheduled - the date of the
// LAST report. Without a year, "Apr 29 AMC" is ambiguous; resolve relative to
// the current year, then fall back to the previous year if that produced a
// future date. Returns null when the format isn't recognized so the original
// string survives unchanged.
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
function parseEarningsDate(raw: string, asOfDate: string): Date | null {
  // Accept "Mon D" or "Mon D AMC/BMO" or "Mon D YYYY"; tolerate extra spaces.
  const m = raw.trim().match(/^([A-Za-z]{3})\s+(\d{1,2})(?:\s+(\d{4}))?(?:\s+(?:amc|bmo|before|after))?/i);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  if (month === undefined || !Number.isFinite(day)) return null;
  const asOf = new Date(`${asOfDate}T00:00:00Z`);
  if (Number.isNaN(asOf.getTime())) return null;
  if (m[3]) return new Date(Date.UTC(Number(m[3]), month, day));
  const guessYear = asOf.getUTCFullYear();
  const candidate = new Date(Date.UTC(guessYear, month, day));
  return candidate;
}

export function formatFinviz(
  data: Json | null | undefined,
  asOfDate: string,
): string | undefined {
  const d = asObject<FinvizData>(data);
  if (!d) return undefined;

  let earningsLine = `Earnings date: ${d.earningsDate ?? "?"}`;
  if (d.earningsDate) {
    const parsed = parseEarningsDate(d.earningsDate, asOfDate);
    if (parsed) {
      const asOf = new Date(`${asOfDate}T00:00:00Z`);
      if (parsed.getTime() < asOf.getTime()) {
        earningsLine = `Earnings date: ${d.earningsDate} (LAST quarter - next earnings not yet posted; browse to confirm)`;
      }
    }
  }

  return [
    `Price: ${num(d.price)}`,
    `Market cap: ${money(d.marketCap)}`,
    `Beta: ${num(d.beta)}`,
    `Debt/Eq: ${num(d.debtEq)}`,
    `Short float: ${pct(d.shortFloat)}`,
    `Avg volume: ${num(d.avgVolume)}  Volume: ${num(d.volume)}`,
    `RSI(14): ${num(d.rsi14)}`,
    `SMA20: ${pct(d.sma20)}  SMA50: ${pct(d.sma50)}  SMA200: ${pct(d.sma200)}`,
    `52w high: ${pct(d.high52w)}  52w low: ${pct(d.low52w)}`,
    earningsLine,
    `Sector: ${d.sector ?? "?"} / Industry: ${d.industry ?? "?"}`,
    `EPS (TTM): ${num(d.epsTtm)}  ROE: ${pct(d.roe)}  P/E: ${num(d.pe)}`,
  ].join("\n");
}

export function formatMacro(rows: readonly MacroRowLike[] | null | undefined): string | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const labels: Record<string, string> = {
    vix: "VIX",
    t10y2y: "10yr-2yr Treasury spread",
    hy_oas: "High-yield OAS (bps)",
    spy_sma200: "SPY vs 200-day SMA (%)",
  };
  const lines = rows
    .filter((r): r is MacroRowLike => !!r && typeof r.metric === "string")
    .map((r) => {
      const name = labels[r.metric] ?? r.metric;
      const asOf = r.as_of ? ` (as of ${r.as_of})` : "";
      // FRED BAMLH0A0HYM2 (HY OAS) is published in percent, but the prompt's
      // GATE 10.6 threshold is in basis points (">500 bps"). Multiply by 100
      // so the rendered value matches the (bps) label and the GATE compares
      // apples to apples.
      const rawValue = r.value;
      const value =
        r.metric === "hy_oas" && typeof rawValue === "number"
          ? Math.round(rawValue * 100)
          : rawValue;
      return `${name}: ${num(value)}${asOf}`;
    });
  return lines.length > 0 ? lines.join("\n") : undefined;
}
