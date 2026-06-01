// Safe accessors for the jsonb columns on the `stocks` table. The columns are
// typed as `Json | null`, so every read is guarded before touching nested fields.
// Shapes mirror the parser contracts in @optionpilot/contracts (FinvizData,
// OptionchartsData, YahooOptionsData, YahooAnalysisData).

import type { Database } from "@optionpilot/contracts";

export type StockRow = Database["public"]["Tables"]["stocks"]["Row"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---- finviz ----------------------------------------------------------------

export interface FinvizView {
  price: number | null;
  marketCap: number | null;
  beta: number | null;
  shortFloat: number | null;
  rsi14: number | null;
  sma200: number | null;
  earningsDate: string | null;
  sector: string | null;
}

export function readFinviz(json: unknown): FinvizView {
  const o = isObject(json) ? json : {};
  return {
    price: num(o.price),
    marketCap: num(o.marketCap),
    beta: num(o.beta),
    shortFloat: num(o.shortFloat),
    rsi14: num(o.rsi14),
    sma200: num(o.sma200),
    earningsDate: str(o.earningsDate),
    sector: str(o.sector),
  };
}

// ---- optioncharts ----------------------------------------------------------

export interface OptionchartsView {
  ivRank: number | null;
  ivPercentile: number | null;
}

export function readOptioncharts(json: unknown): OptionchartsView {
  const o = isObject(json) ? json : {};
  return {
    ivRank: num(o.ivRank),
    ivPercentile: num(o.ivPercentile),
  };
}

// ---- yahoo_options ---------------------------------------------------------

export interface PutQuote {
  strike: number;
  mid: number | null;
  bid: number | null;
  ask: number | null;
  iv: number | null;
}

export interface OptionsExpirationView {
  expiry: string;
  puts: PutQuote[];
}

export interface YahooOptionsView {
  price: number | null;
  expirations: OptionsExpirationView[];
}

export function readYahooOptions(json: unknown): YahooOptionsView {
  const o = isObject(json) ? json : {};
  const rawExpirations = Array.isArray(o.expirations) ? o.expirations : [];
  const expirations: OptionsExpirationView[] = [];
  for (const rawExp of rawExpirations) {
    if (!isObject(rawExp)) continue;
    const expiry = str(rawExp.expiry);
    if (!expiry) continue;
    const rawPuts = Array.isArray(rawExp.puts) ? rawExp.puts : [];
    const puts: PutQuote[] = [];
    for (const rawPut of rawPuts) {
      if (!isObject(rawPut)) continue;
      const strike = num(rawPut.strike);
      if (strike === null) continue;
      puts.push({
        strike,
        mid: num(rawPut.mid),
        bid: num(rawPut.bid),
        ask: num(rawPut.ask),
        iv: num(rawPut.iv),
      });
    }
    expirations.push({ expiry, puts });
  }
  return { price: num(o.price), expirations };
}

// Normalize an ISO/date-only string to YYYY-MM-DD for matching.
function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// Look up the mid price of the put matching a given expiry + strike.
export function findPutMid(
  json: unknown,
  expiry: string,
  strike: number,
): number | null {
  const { expirations } = readYahooOptions(json);
  const wantExpiry = dateKey(expiry);
  for (const exp of expirations) {
    if (dateKey(exp.expiry) !== wantExpiry) continue;
    for (const put of exp.puts) {
      if (Math.abs(put.strike - strike) < 1e-6) return put.mid;
    }
  }
  return null;
}

// Best-available current spot price for a symbol (finviz first, then yahoo).
export function readPrice(row: Pick<StockRow, "finviz" | "yahoo_options">): number | null {
  const finviz = readFinviz(row.finviz);
  if (finviz.price !== null) return finviz.price;
  return readYahooOptions(row.yahoo_options).price;
}
