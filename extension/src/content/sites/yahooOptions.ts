// Owner: Parser agent (yahoo). Source pages:
//   yahoo_options -> https://ca.finance.yahoo.com/quote/<sym>/options/
//   yahoo_vix     -> https://ca.finance.yahoo.com/quote/%5EVIX
import type {
  OptionQuote,
  Parser,
  YahooMarketState,
  YahooOptionsData,
  YahooOptionsExpiration,
} from "@optionpilot/contracts";
import {
  asData,
  finStreamerValue,
  parseFraction,
  parseNumber,
  resolveSymbol,
  rowCells,
} from "./parseUtils";

// OCC-style contract names, e.g. AAPL260601P00250000 => AAPL, 26-06-01, Put, 250.000
const CONTRACT_RE = /^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

// The page's OWN quote price lives in a dedicated `[data-testid="qsp-price"]`
// element on the current Yahoo layout. The page ALSO renders a market-movers
// strip full of <fin-streamer data-field="regularMarketPrice"> for unrelated
// tickers (BTC-USD, CL=F, ...) that are NOT wrapped in li/nav/aside, so a naive
// querySelector grabs the wrong quote. Prefer qsp-price; only fall back to a
// fin-streamer explicitly scoped to the page's symbol.
function readUnderlyingPrice(doc: Document, symbol?: string): number | null {
  const qsp = parseNumber(doc.querySelector('[data-testid="qsp-price"]')?.textContent);
  if (qsp != null) return qsp;

  const wanted = (symbol ?? "").toUpperCase();
  if (wanted) {
    const streamers = Array.from(
      doc.querySelectorAll<HTMLElement>('fin-streamer[data-field="regularMarketPrice"]'),
    );
    for (const el of streamers) {
      if ((el.getAttribute("data-symbol") ?? "").toUpperCase() === wanted) {
        const v = finStreamerValue(el);
        if (v != null) return v;
      }
    }
  }

  const tagged = finStreamerValue(doc.querySelector('fin-streamer[data-test="qsp-price"]'));
  return tagged;
}

// Read Yahoo's quote `marketState` so downstream code can refuse to treat a
// closed/pre/post snapshot as live quotes. Tries the per-symbol fin-streamer
// first (matches the right ticker on the page), then any marketState
// fin-streamer as a fallback, then the human-readable market-notice DOM node.
// Returns "UNKNOWN" only when none of those exist.
const VALID_STATES: ReadonlySet<YahooMarketState> = new Set([
  "REGULAR",
  "PRE",
  "POST",
  "CLOSED",
]);
function canonicalState(raw: string | null | undefined): YahooMarketState | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  // Yahoo uses "PREPRE" / "POSTPOST" between halt boundaries; collapse to PRE/POST.
  if (up.startsWith("PRE")) return "PRE";
  if (up.startsWith("POST")) return "POST";
  if (up === "REGULAR") return "REGULAR";
  if (up === "CLOSED") return "CLOSED";
  return VALID_STATES.has(up as YahooMarketState) ? (up as YahooMarketState) : null;
}

function readMarketState(doc: Document, symbol?: string): YahooMarketState {
  const wanted = (symbol ?? "").toUpperCase();
  if (wanted) {
    const scoped = doc.querySelector<HTMLElement>(
      `fin-streamer[data-field="marketState"][data-symbol="${wanted}"]`,
    );
    const v = canonicalState(scoped?.getAttribute("value") ?? scoped?.textContent ?? null);
    if (v) return v;
  }
  const anyStreamer = doc.querySelector<HTMLElement>(
    'fin-streamer[data-field="marketState"]',
  );
  const fromStreamer = canonicalState(
    anyStreamer?.getAttribute("value") ?? anyStreamer?.textContent ?? null,
  );
  if (fromStreamer) return fromStreamer;

  // Yahoo also renders a human-readable banner ("Market Closed.", "At close",
  // "Pre-Market", "After hours") inside [data-testid="market-time-notice"].
  // Tolerate layout drift by also accepting any node containing those phrases.
  const noticeEl =
    doc.querySelector('[data-testid="market-time-notice"]') ??
    doc.querySelector('[data-testid="qsp-market-state"]');
  const noticeText = (noticeEl?.textContent ?? "").toLowerCase();
  if (noticeText) {
    if (/pre[-\s]?market/.test(noticeText)) return "PRE";
    if (/after\s*hours|post[-\s]?market/.test(noticeText)) return "POST";
    if (/market\s*closed|^closed\b|at\s*close/.test(noticeText)) return "CLOSED";
    if (/market\s*open|live/.test(noticeText)) return "REGULAR";
  }
  return "UNKNOWN";
}

type OptCol =
  | "contract"
  | "lastDate"
  | "strike"
  | "last"
  | "bid"
  | "ask"
  | "change"
  | "pctChange"
  | "volume"
  | "openInterest"
  | "iv";

// Map a Yahoo options header cell to a column key. Order matters: more specific
// labels ("Last Trade Date", "% Change") are matched before generic ones.
function classifyOptHeader(header: string): OptCol | null {
  const h = header.toLowerCase();
  if (/contract/.test(h)) return "contract";
  if (/trade date|last trade/.test(h)) return "lastDate";
  if (/strike/.test(h)) return "strike";
  if (/implied|^iv$/.test(h)) return "iv";
  if (/open\s*int/.test(h)) return "openInterest";
  if (/^bid$/.test(h)) return "bid";
  if (/^ask$/.test(h)) return "ask";
  if (/(%|percent)\s*change/.test(h)) return "pctChange";
  if (/change/.test(h)) return "change";
  if (/last\s*price|^last$/.test(h)) return "last";
  if (/vol/.test(h)) return "volume";
  return null;
}

// Yahoo's current layout: Contract Name | Last Trade Date | Strike | Last Price
// | Bid | Ask | Change | % Change | Volume | Open Interest | Implied Volatility.
const DEFAULT_OPT_COLS: Record<OptCol, number> = {
  contract: 0,
  lastDate: 1,
  strike: 2,
  last: 3,
  bid: 4,
  ask: 5,
  change: 6,
  pctChange: 7,
  volume: 8,
  openInterest: 9,
  iv: 10,
};

function optionTableColumns(table: HTMLTableElement): Partial<Record<OptCol, number>> {
  const headerRow = table.querySelector("thead tr") ?? table.querySelector("tr");
  const heads = rowCells(headerRow);
  const cols: Partial<Record<OptCol, number>> = {};
  heads.forEach((h, i) => {
    const key = classifyOptHeader(h);
    if (key && cols[key] === undefined) cols[key] = i;
  });
  // Fall back to the known default order if the header didn't classify cleanly.
  if (cols.strike === undefined || cols.bid === undefined) return DEFAULT_OPT_COLS;
  return cols;
}

export const parseYahooOptions: Parser = (doc, ctx) => {
  try {
    const putsByExpiry = new Map<string, OptionQuote[]>();
    let symbolFromContract = "";

    for (const table of Array.from(doc.querySelectorAll("table"))) {
      const cols = optionTableColumns(table as HTMLTableElement);
      const bodyRows = table.querySelector("tbody")
        ? Array.from(table.querySelectorAll("tbody tr"))
        : Array.from(table.querySelectorAll("tr")).slice(1);

      for (const row of bodyRows) {
        const cells = rowCells(row);
        if (cells.length < 4) continue;
        const at = (key: OptCol): string | undefined => {
          const i = cols[key];
          return i === undefined ? undefined : cells[i];
        };
        const contract = (at("contract") ?? cells[0]).toUpperCase();
        const match = contract.match(CONTRACT_RE);
        if (!match) continue;
        // This is a cash-secured-put tool: keep PUT rows only.
        if (match[5] !== "P") continue;

        symbolFromContract = match[1];
        const expiry = `20${match[2]}-${match[3]}-${match[4]}`;
        const strikeFromName = Number(match[6]) / 1000;

        const strike = parseNumber(at("strike")) ?? strikeFromName;
        const last = parseNumber(at("last"));
        const bid = parseNumber(at("bid"));
        const ask = parseNumber(at("ask"));
        const volume = parseNumber(at("volume"));
        const openInterest = parseNumber(at("openInterest"));
        const iv = parseFraction(at("iv"));
        const mid = bid != null && ask != null ? (bid + ask) / 2 : null;

        const quote: OptionQuote = {
          strike,
          bid,
          ask,
          mid,
          last,
          volume,
          openInterest,
          iv,
        };
        const list = putsByExpiry.get(expiry);
        if (list) list.push(quote);
        else putsByExpiry.set(expiry, [quote]);
      }
    }

    const symbol = resolveSymbol(doc, ctx) || symbolFromContract;
    if (!symbol) return null;

    const price = readUnderlyingPrice(doc, symbol);
    const expirations: YahooOptionsExpiration[] = Array.from(
      putsByExpiry.entries(),
    ).map(([expiry, puts]) => ({ expiry, puts }));

    if (price == null && expirations.length === 0) return null;

    // Capture marketState alongside the chain so downstream consumers can
    // refuse to evaluate a closed/pre/post snapshot. Fallback: if the parser
    // didn't find a marketState field but EVERY bid+ask in the chain is zero,
    // treat as CLOSED - that's Yahoo's reliable signal for "the book is shut".
    let marketState = readMarketState(doc, symbol);
    if (marketState === "UNKNOWN" || marketState === "REGULAR") {
      let totalQuotes = 0;
      let zeroQuotes = 0;
      for (const exp of expirations) {
        for (const p of exp.puts) {
          if (p.bid == null && p.ask == null) continue;
          totalQuotes += 1;
          if ((p.bid ?? 0) === 0 && (p.ask ?? 0) === 0) zeroQuotes += 1;
        }
      }
      if (totalQuotes > 0 && zeroQuotes === totalQuotes) marketState = "CLOSED";
    }

    const data: YahooOptionsData = { price, expirations, marketState };
    return {
      kind: "stock_json",
      symbol,
      column: "yahoo_options",
      data: asData(data),
    };
  } catch {
    return null;
  }
};

export const parseYahooVix: Parser = (doc) => {
  try {
    // The VIX quote streamer carries data-symbol="^VIX".
    const value = readUnderlyingPrice(doc, "^VIX");
    if (value == null) return null;
    return { kind: "macro", metric: "vix", value };
  } catch {
    return null;
  }
};
