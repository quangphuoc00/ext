// Owner: Parser agent (finviz). Source pages:
//   finviz     -> https://finviz.com/quote.ashx?t=<sym>   (.snapshot-table2)
//   finviz_spy -> https://finviz.com/quote.ashx?t=SPY     (SMA200 -> macro spy_sma200)
import type { FinvizData, Parser } from "@optionpilot/contracts";
import {
  asData,
  parseNumber,
  resolveSymbol,
  text,
} from "./parseUtils";

// .snapshot-table2 is a flat grid of <td> cells alternating label,value,label,...
function buildSnapshotMap(doc: Document): Map<string, string> | null {
  const table = doc.querySelector("table.snapshot-table2");
  if (!table) return null;
  const cells = Array.from(table.querySelectorAll("td")).map((c) => text(c));
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const label = cells[i];
    if (label) map.set(label.toLowerCase(), cells[i + 1]);
  }
  return map;
}

function get(map: Map<string, string>, re: RegExp): string | undefined {
  for (const [label, value] of map) {
    if (re.test(label)) return value;
  }
  return undefined;
}

// Some finviz cells pack two numbers, e.g. 52W High = "313.26 -0.38%" (absolute
// then % distance from the level). We keep the relative % (matches SMA20/50/200
// semantics); a bare parseNumber would choke on the two-number string.
function relativePercent(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.match(/(-?\d[\d,]*\.?\d*)\s*%/);
  return m ? parseNumber(m[1]) : parseNumber(value);
}

function findLinkText(doc: Document, hrefFragment: string): string | null {
  const links = Array.from(
    doc.querySelectorAll<HTMLAnchorElement>("a[href]"),
  );
  for (const a of links) {
    if (a.getAttribute("href")?.includes(hrefFragment)) {
      const t = text(a);
      if (t) return t;
    }
  }
  return null;
}

export const parseFinviz: Parser = (doc, ctx) => {
  try {
    const symbol = resolveSymbol(doc, ctx);
    if (!symbol) return null;

    const map = buildSnapshotMap(doc);
    if (!map) return null;

    const earnings = get(map, /^earnings$/);
    const data: FinvizData = {
      price: parseNumber(get(map, /^price$/)),
      marketCap: parseNumber(get(map, /^market cap$/)),
      beta: parseNumber(get(map, /^beta$/)),
      debtEq: parseNumber(get(map, /^debt\/eq$/)),
      shortFloat: parseNumber(get(map, /^short float/)),
      avgVolume: parseNumber(get(map, /^avg volume$/)),
      volume: parseNumber(get(map, /^volume$/)),
      rsi14: parseNumber(get(map, /^rsi/)),
      sma20: parseNumber(get(map, /^sma20$/)),
      sma50: parseNumber(get(map, /^sma50$/)),
      sma200: parseNumber(get(map, /^sma200$/)),
      high52w: relativePercent(get(map, /^52w high$/)),
      low52w: relativePercent(get(map, /^52w low$/)),
      earningsDate: earnings && earnings.trim() ? earnings : null,
      sector: findLinkText(doc, "f=sec_"),
      industry: findLinkText(doc, "f=ind_"),
      epsTtm: parseNumber(get(map, /^eps \(ttm\)$/)),
      roe: parseNumber(get(map, /^roe$/)),
      pe: parseNumber(get(map, /^p\/e$/)),
    };

    return {
      kind: "stock_json",
      symbol,
      column: "finviz",
      data: asData(data),
    };
  } catch {
    return null;
  }
};

export const parseFinvizSpy: Parser = (doc) => {
  try {
    const map = buildSnapshotMap(doc);
    if (!map) return null;
    const value = parseNumber(get(map, /^sma200$/));
    if (value == null) return null;
    return { kind: "macro", metric: "spy_sma200", value };
  } catch {
    return null;
  }
};
