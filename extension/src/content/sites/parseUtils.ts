// Owner: Parser agent (shared). Defensive number/text/DOM parsing helpers used by
// every site parser. Everything here is best-effort: functions return null (or "")
// instead of throwing so a single bad page never crashes the content script.
import type { ParseContext } from "@optionpilot/contracts";

const NULL_TOKENS = new Set([
  "",
  "-",
  "--",
  "—",
  "–",
  "n/a",
  "na",
  "null",
  "nan",
  "—",
]);

/** Collapse whitespace and trim. Safe for null/undefined. */
export function cleanText(value: string | null | undefined): string {
  if (value == null) return "";
  return value.replace(/\s+/g, " ").trim();
}

/** Convenience: cleaned textContent of an element (or "" if absent). */
export function text(el: Element | null | undefined): string {
  return cleanText(el?.textContent);
}

/**
 * Parse a human-formatted number into a JS number.
 * - strips $ , % and whitespace
 * - understands magnitude suffixes K(1e3) M(1e6) B(1e9) T(1e12)
 * - treats (1.2) as -1.2
 * - treats "-", "N/A", "" etc. as null
 * The leading '%' is stripped, so "21%" -> 21 (the percent magnitude). Use
 * parseFraction() when you want 21% -> 0.21.
 */
export function parseNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === "") return null;
  if (NULL_TOKENS.has(s.toLowerCase())) return null;

  let negative = false;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) {
    negative = true;
    s = paren[1];
  }

  let work = s.replace(/[,$\s%]/g, "");
  if (work === "" || NULL_TOKENS.has(work.toLowerCase())) return null;

  let multiplier = 1;
  const suffix = work.match(/([kmbt])$/i);
  if (suffix) {
    const c = suffix[1].toLowerCase();
    multiplier = c === "k" ? 1e3 : c === "m" ? 1e6 : c === "b" ? 1e9 : 1e12;
    work = work.slice(0, -1);
  }

  const num = Number(work);
  if (!Number.isFinite(num)) return null;
  const result = num * multiplier;
  return negative ? -Math.abs(result) : result;
}

/** Parse a percentage into a fraction: "21%" / "21" -> 0.21. */
export function parseFraction(raw: string | null | undefined): number | null {
  const n = parseNumber(raw);
  return n == null ? null : n / 100;
}

/** Cast a typed parser shape into the contract's `data: Record<string, unknown>`. */
export function asData<T extends object>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

/** Cells (th/td) of a table row as cleaned text. */
export function rowCells(row: Element | null | undefined): string[] {
  if (!row) return [];
  return Array.from(row.querySelectorAll("th,td")).map((c) => text(c));
}

/**
 * Resolve the symbol for per-symbol writes: prefer ctx.symbol, otherwise derive
 * it from the page URL (finviz ?t=, /quote/<sym>/, /options/<sym>/,
 * /stock-details/<sym>/). Returns "" when nothing usable is found.
 */
export function resolveSymbol(doc: Document, ctx: ParseContext): string {
  if (ctx.symbol && ctx.symbol.trim()) return ctx.symbol.trim().toUpperCase();
  const href = doc.location?.href ?? "";
  if (!href) return "";
  try {
    const u = new URL(href);
    const t = u.searchParams.get("t");
    if (t) return t.toUpperCase();
    const segs = u.pathname.split("/").filter(Boolean);
    for (const anchor of ["quote", "options", "stock-details"]) {
      const i = segs.indexOf(anchor);
      if (i >= 0 && segs[i + 1]) {
        return decodeURIComponent(segs[i + 1]).toUpperCase();
      }
    }
  } catch {
    return "";
  }
  return "";
}

/**
 * Read a fin-streamer element's numeric value. Yahoo keeps the raw number in the
 * `value` attribute and a formatted copy in the text node; prefer the attribute.
 */
export function finStreamerValue(el: Element | null | undefined): number | null {
  if (!el) return null;
  const attr = parseNumber(el.getAttribute("value"));
  if (attr != null) return attr;
  return parseNumber(el.textContent);
}

/**
 * Best-effort "labeled value" lookup for card/overview layouts: find a leaf-ish
 * element whose visible text matches `label`, then read the nearest number from
 * inline text, a sibling, or another child of the same parent. Returns the
 * percent magnitude (e.g. 28.51), not a fraction.
 */
export function findValueByLabel(
  doc: Document,
  label: RegExp,
): number | null {
  const all = Array.from(doc.querySelectorAll("body *"));
  for (const el of all) {
    const txt = text(el);
    if (!txt || txt.length > 80 || !label.test(txt)) continue;

    // Case A: "IV Rank 28.51%" lives in a single element.
    const inline = txt.replace(label, "").replace(/^[:\s]+/, "");
    const inlineNum = parseNumber(inline);
    if (inlineNum != null) return inlineNum;

    // Case B: value sits in a neighbouring element.
    const neighbors: (Element | null)[] = [
      el.nextElementSibling,
      el.previousElementSibling,
      el.parentElement?.nextElementSibling ?? null,
    ];
    for (const n of neighbors) {
      const num = parseNumber(n?.textContent);
      if (num != null) return num;
    }

    // Case C: another child of the same parent holds the value.
    const parent = el.parentElement;
    if (parent) {
      for (const child of Array.from(parent.children)) {
        if (child === el) continue;
        const num = parseNumber(child.textContent);
        if (num != null) return num;
      }
    }
  }
  return null;
}

/**
 * Find the first <table> that appears after (or inside) a short element whose
 * text matches `heading`. Tables are returned in document order, so the first
 * one following the heading is the nearest.
 */
export function findTableAfterHeading(
  doc: Document,
  heading: RegExp,
): HTMLTableElement | null {
  const tables = Array.from(doc.querySelectorAll("table"));
  if (tables.length === 0) return null;

  const candidates = Array.from(
    doc.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,p,section,header,caption"),
  );
  let headingEl: Element | null = null;
  for (const el of candidates) {
    const txt = text(el);
    if (txt && txt.length < 80 && heading.test(txt)) {
      headingEl = el;
      break;
    }
  }
  if (!headingEl) return null;

  for (const t of tables) {
    const pos = headingEl.compareDocumentPosition(t);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return t as HTMLTableElement;
  }
  return null;
}
