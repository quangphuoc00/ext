// Owner: Parser agent (stockoracle). Source page (LOGIN-GATED - user must be logged in):
//   stockoracle -> https://app.stockoracle.com/stock-details/<sym>/overview
//
// The fair/intrinsic value is shown in the header valuation badge next to a
// method selector labelled "OracleValue™" (e.g. [Wide Moat] [OracleValue™ ▼]
// [240.52]). The big number beside it (e.g. 312.06) is the *current price*, in a
// separate block - so we anchor on the method label and read the price that
// shares its badge container, never the standalone price.
import type { Parser } from "@optionpilot/contracts";
import { cleanText, resolveSymbol } from "./parseUtils";

// Valuation-method labels, most specific (StockOracle's default) first.
const METHOD_LABEL = /(oracle\s*value|fair\s*value|intrinsic\s*value)/i;

// A text node that is *only* a plain per-share price: "240.52", "$240.52",
// "1,234.5". Rejects percentages, magnitude suffixes (M/B), ranges, and words.
function priceToken(raw: string | null | undefined): number | null {
  const t = cleanText(raw).replace(/USD/gi, "").trim();
  if (!t || t.includes("%")) return null;
  const m = t.match(/^\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return n;
}

// First plain-price text node inside `root`, optionally skipping anything inside
// `exclude`. Document order means the badge's value wins.
function findPriceInSubtree(
  root: Element,
  exclude?: Element | null,
): number | null {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  let node: Node | null = walker.nextNode();
  while (node) {
    if (!exclude || !exclude.contains(node)) {
      const n = priceToken(node.textContent);
      if (n != null) return n;
    }
    node = walker.nextNode();
  }
  return null;
}

// Climb from the method label toward the badge container, returning the closest
// enclosing element that also holds a price. The smallest such ancestor is the
// badge row, so we get the fair value (240.52) and not the page price (312.06).
function priceNearLabel(label: Element): number | null {
  // The badge value can live INSIDE the method label (e.g. a single
  // "OracleValue™ 240.52" button) just as easily as beside it. Check the
  // label's own subtree first, otherwise we skip it and fall through to the
  // standalone page price in an ancestor.
  const inside = findPriceInSubtree(label);
  if (inside != null) return inside;
  let node: Element | null = label.parentElement;
  for (let depth = 0; depth < 5 && node; depth++) {
    const n = findPriceInSubtree(node, label);
    if (n != null) return n;
    node = node.parentElement;
  }
  return null;
}

export const parseStockoracle: Parser = (doc, ctx) => {
  try {
    const symbol = resolveSymbol(doc, ctx);
    if (!symbol) return null;

    // StockOracle shows this banner when its API fails mid-render. Return null
    // so scrapeWithReadiness retries instead of persisting a garbage value.
    if (/error loading data/i.test(doc.body?.textContent ?? "")) return null;

    // Find the (innermost) element whose short text names the valuation method,
    // then read the price that shares its badge.
    const candidates = Array.from(
      doc.querySelectorAll("button,[role='combobox'],[role='button'],span,div,a,p"),
    );
    for (const el of candidates) {
      const t = cleanText(el.textContent).replace(/™/g, "").trim();
      if (!t || t.length > 30 || !METHOD_LABEL.test(t)) continue;
      const value = priceNearLabel(el);
      if (value != null) return { kind: "stock_intrinsic", symbol, value };
    }

    return null;
  } catch {
    return null;
  }
};
