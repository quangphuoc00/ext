// Owner: Parser agent (fred). Source pages:
//   fred_t10y2y -> https://fred.stlouisfed.org/series/T10Y2Y
//   fred_hyoas  -> https://fred.stlouisfed.org/series/BAMLH0A0HYM2
import type { MacroMetric, Parser, ScrapeWrite } from "@optionpilot/contracts";
import { parseNumber } from "./parseUtils";

// Latest observation text looks like:
//   "2026-05-29: 0.47 | Percent, Not Seasonally Adjusted | Daily"
// Prefer the strict form (trailing " | ...") and fall back to a looser match.
const STRICT_RE = /(\d{4}-\d{2}-\d{2})\s*:\s*(-?\d+(?:\.\d+)?)\s*\|/;
const LOOSE_RE = /(\d{4}-\d{2}-\d{2})\s*:\s*(-?\d+(?:\.\d+)?)/;

function findObservation(
  doc: Document,
  re: RegExp,
): { value: number; asOf: string } | null {
  // Walk every element and keep the match from the most specific (shortest) one
  // so we read the leaf observation node, not a giant wrapper.
  let best: RegExpMatchArray | null = null;
  let bestLen = Infinity;
  for (const el of Array.from(doc.querySelectorAll("body *"))) {
    const txt = el.textContent;
    if (!txt) continue;
    const m = txt.match(re);
    if (m && txt.length < bestLen) {
      best = m;
      bestLen = txt.length;
    }
  }
  if (!best) return null;
  const value = parseNumber(best[2]);
  if (value == null) return null;
  return { value, asOf: best[1] };
}

function parseFred(doc: Document, metric: MacroMetric): ScrapeWrite | null {
  try {
    const found =
      findObservation(doc, STRICT_RE) ?? findObservation(doc, LOOSE_RE);
    if (!found) return null;
    return { kind: "macro", metric, value: found.value, asOf: found.asOf };
  } catch {
    return null;
  }
}

export const parseFredT10Y2Y: Parser = (doc) => parseFred(doc, "t10y2y");

export const parseFredHyOas: Parser = (doc) => parseFred(doc, "hy_oas");
