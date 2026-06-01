// Owner: Parser agent (optioncharts). Source page (free overview):
//   optioncharts -> https://optioncharts.io/options/<sym>
// The overview exposes IV stats (IV 30d / IV Rank / IV Percentile), put & call
// volume, and an Option Chain Statistics table (per-expiration aggregates). The
// per-strike Calls + Puts greeks chain that used to live here is now paywalled
// (the page renders an "Upgrade to unlock this feature" wall in place of the
// chain for non-premium visitors). `greeks` therefore comes back as [] on the
// free tier; we still scrape the overview metrics and surface the paywall
// state in `paywalled` so the summary can explain why greeks are empty without
// looking like a parser bug.
import type {
  OptionchartsData,
  OptionGreek,
  Parser,
} from "@optionpilot/contracts";
import {
  asData,
  findValueByLabel,
  parseFraction,
  parseNumber,
  resolveSymbol,
  rowCells,
  text,
} from "./parseUtils";

type ColumnKey =
  | "strike"
  | "bid"
  | "mid"
  | "ask"
  | "volume"
  | "openInterest"
  | "iv"
  | "delta"
  | "gamma"
  | "theta"
  | "vega";

function classifyHeader(header: string): ColumnKey | null {
  const h = header.toLowerCase();
  if (/open\s*int|^oi$/.test(h)) return "openInterest";
  if (/implied|^iv$/.test(h)) return "iv";
  if (/strike/.test(h)) return "strike";
  if (/^bid$/.test(h)) return "bid";
  if (/^mid$/.test(h)) return "mid";
  if (/^ask$/.test(h)) return "ask";
  if (/vol/.test(h)) return "volume";
  if (/delta/.test(h)) return "delta";
  if (/gamma/.test(h)) return "gamma";
  if (/theta/.test(h)) return "theta";
  if (/vega/.test(h)) return "vega";
  return null;
}

function headerRowOf(table: HTMLTableElement): Element | null {
  return table.querySelector("thead tr") ?? table.querySelector("tr");
}

// Greeks tables are the only ones with both a Strike and a Delta column (the
// volume/OI statistics tables have neither). Theta/Vega may be missing/clipped,
// so we don't require the full greek set - just strike + delta.
function allGreeksTables(doc: Document): HTMLTableElement[] {
  const out: HTMLTableElement[] = [];
  for (const table of Array.from(doc.querySelectorAll("table"))) {
    const headerRow = headerRowOf(table as HTMLTableElement);
    if (!headerRow) continue;
    const heads = rowCells(headerRow).map((h) => h.toLowerCase());
    const hasStrike = heads.some((h) => /strike/.test(h));
    const hasDelta = heads.some((h) => /delta/.test(h));
    if (hasStrike && hasDelta) out.push(table as HTMLTableElement);
  }
  return out;
}

function findHeading(doc: Document, re: RegExp): Element | null {
  const els = Array.from(
    doc.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,p"),
  );
  for (const el of els) {
    const t = text(el);
    if (t && t.length < 40 && re.test(t)) return el;
  }
  return null;
}

// This is a cash-secured-put tool, so we want the PUTS greeks. The chain stacks
// Calls then Puts, so prefer the greeks table after the "Puts" heading, falling
// back to the second greeks table (Calls is first).
function findPutsGreeksTable(doc: Document): HTMLTableElement | null {
  const tables = allGreeksTables(doc);
  if (tables.length === 0) return null;
  const putsHeading = findHeading(doc, /^puts$/i);
  if (putsHeading) {
    for (const t of tables) {
      if (
        putsHeading.compareDocumentPosition(t) &
        Node.DOCUMENT_POSITION_FOLLOWING
      ) {
        return t;
      }
    }
  }
  return tables.length >= 2 ? tables[1] : tables[0];
}

// The chain is shown for a single selected expiration; grab the first ISO date
// on the page (the expiration selector value).
function findSelectedExpiry(doc: Document): string {
  const iso = doc.body?.textContent?.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return iso ? iso[1] : "";
}

// True when the page is showing the upgrade interstitial in place of the
// per-strike greeks chain. Detected by the marketing heading the site renders
// for locked features ("Upgrade to unlock this feature"). Conservative: only
// matches the heading text so a generic "Upgrade" nav link doesn't false-fire.
function isGreeksPaywalled(doc: Document): boolean {
  const headings = Array.from(
    doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'),
  );
  for (const h of headings) {
    const t = text(h);
    if (t && /upgrade to unlock this feature/i.test(t)) return true;
  }
  return false;
}

export const parseOptioncharts: Parser = (doc, ctx) => {
  try {
    const symbol = resolveSymbol(doc, ctx);
    if (!symbol) return null;

    // Skip the per-strike greeks search entirely when the page is showing the
    // paywall: any "Strike + Delta" tables that survive would be marketing
    // teasers, not real data. The overview metrics below render outside the
    // paywall and stay available.
    const paywalled = isGreeksPaywalled(doc);
    const greeks: OptionGreek[] = [];
    const table = paywalled ? null : findPutsGreeksTable(doc);
    if (table) {
      const headerRow = headerRowOf(table);
      const heads = rowCells(headerRow);
      const colIndex: Partial<Record<ColumnKey, number>> = {};
      heads.forEach((h, i) => {
        const key = classifyHeader(h);
        if (key && colIndex[key] === undefined) colIndex[key] = i;
      });

      const expiry = findSelectedExpiry(doc);
      const bodyRows = table.querySelector("tbody")
        ? Array.from(table.querySelectorAll("tbody tr"))
        : Array.from(table.querySelectorAll("tr")).slice(1);

      for (const row of bodyRows) {
        const cells = rowCells(row);
        if (cells.length === 0) continue;
        const at = (key: ColumnKey): string | undefined => {
          const i = colIndex[key];
          return i === undefined ? undefined : cells[i];
        };
        const strike = parseNumber(at("strike"));
        if (strike == null) continue; // skip subtotal/empty rows
        greeks.push({
          expiry,
          strike,
          delta: parseNumber(at("delta")),
          gamma: parseNumber(at("gamma")),
          theta: parseNumber(at("theta")),
          vega: parseNumber(at("vega")),
          iv: parseFraction(at("iv")),
        });
      }
    }

    // Overview metrics (IV Rank / IV Percentile kept as percent magnitudes;
    // IV(30d) stored as a fraction). Labels live in the "Implied Volatility"
    // stat grid; we avoid the long "Option Overview" paragraph (length-gated).
    const ivRank = findValueByLabel(doc, /iv\s*rank/i);
    const ivPercentile = findValueByLabel(doc, /iv\s*percentile/i);
    const iv30dPct = findValueByLabel(doc, /implied\s*volatility\s*\(?\s*30/i);
    const iv30d = iv30dPct == null ? null : iv30dPct / 100;
    // OptionCharts renames this tile occasionally; try each known variant in
    // order of recency. The tile renders as e.g. "Expected Move $15.50" with
    // the $ stripped by parseNumber so the dollar amount comes back as a
    // plain number (15.50). When the page is rendered in fraction form
    // ("Expected Move 2.4%") the value comes back as 2.4 - downstream consumers
    // can't distinguish $ vs % from the value alone, but the prompt formatter
    // computes its own fallback from iv30d * price when this is null.
    const expectedMove =
      findValueByLabel(doc, /expected\s*move/i) ??
      findValueByLabel(doc, /implied\s*move/i) ??
      findValueByLabel(doc, /1[- ]?(?:sigma|sd)\s*move/i) ??
      findValueByLabel(doc, /move\s*\(?\s*30/i);

    // Prefer the volume put-call ratio computed from Put/Call volume (the page
    // also shows an OI-based ratio, so a bare "Put-Call Ratio" lookup is
    // ambiguous). Fall back to a direct label only if volumes are missing.
    const putVol = findValueByLabel(doc, /put\s*volume/i);
    const callVol = findValueByLabel(doc, /call\s*volume/i);
    let putCallRatio =
      putVol != null && callVol != null && callVol !== 0
        ? putVol / callVol
        : null;
    if (putCallRatio == null) {
      putCallRatio = findValueByLabel(doc, /put[-/\s]*call\s*ratio/i);
    }

    const hasAny =
      greeks.length > 0 ||
      ivRank != null ||
      ivPercentile != null ||
      iv30d != null ||
      expectedMove != null ||
      putCallRatio != null ||
      paywalled;
    if (!hasAny) return null;

    const data: OptionchartsData = {
      ivRank,
      ivPercentile,
      iv30d,
      expectedMove,
      putCallRatio,
      greeks,
      greeksPaywalled: paywalled,
    };
    return {
      kind: "stock_json",
      symbol,
      column: "optioncharts",
      data: asData(data),
    };
  } catch {
    return null;
  }
};
