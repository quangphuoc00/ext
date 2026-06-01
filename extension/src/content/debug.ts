// Raw per-source DOM probe captured alongside each parse. This is intentionally
// generic and defensive: it does NOT depend on the parser succeeding. The goal
// is that a single copied diagnostics report contains enough raw DOM evidence
// to fix a selector without needing live browser inspection.
import type { SourceId } from "@optionpilot/contracts";

const MAX_ITEMS = 40;

function txt(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

// Yahoo prices live in <fin-streamer> custom elements. Dumping their attributes
// reveals the right data-field / data-symbol to target.
function finStreamers(doc: Document): unknown[] {
  return Array.from(doc.querySelectorAll("fin-streamer"))
    .slice(0, MAX_ITEMS)
    .map((el) => ({
      field: el.getAttribute("data-field"),
      symbol: el.getAttribute("data-symbol"),
      value: el.getAttribute("data-value"),
      active: el.getAttribute("active"),
      text: txt(el),
    }));
}

// First data table on the page: header cells + first couple of rows. Reveals
// column order so the parser can map indexes correctly.
function tableShape(table: HTMLTableElement | null): unknown {
  if (!table) return null;
  const headerRow =
    table.querySelector("thead tr") ?? table.querySelector("tr");
  const headers = headerRow
    ? Array.from(headerRow.querySelectorAll("th,td")).map((c) => txt(c))
    : [];
  const bodyRows = Array.from(
    table.querySelectorAll("tbody tr"),
  ).length
    ? Array.from(table.querySelectorAll("tbody tr"))
    : Array.from(table.querySelectorAll("tr")).slice(1);
  const rows = bodyRows
    .slice(0, 3)
    .map((r) => Array.from(r.querySelectorAll("td,th")).map((c) => txt(c)));
  return { headers, rows };
}

function allTables(doc: Document): unknown[] {
  return Array.from(doc.querySelectorAll("table"))
    .slice(0, 6)
    .map((t) => tableShape(t as HTMLTableElement));
}

// Finviz packs everything into a label/value grid; emit the full map so any
// missing field (52W High/Low etc.) can be matched by its exact label text.
function finvizMap(doc: Document): Record<string, string> {
  const out: Record<string, string> = {};
  const table =
    doc.querySelector("table.snapshot-table2") ??
    doc.querySelector(".snapshot-table2");
  const cells = table
    ? Array.from(table.querySelectorAll("td"))
    : Array.from(doc.querySelectorAll("td"));
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const label = txt(cells[i]);
    const value = txt(cells[i + 1]);
    if (label) out[label] = value;
  }
  return out;
}

// Detect whether a login wall is showing (StockOracle is auth-gated; also used
// to spot a paywall/redirect on optioncharts).
function loginState(doc: Document): Record<string, unknown> {
  const hasPassword = !!doc.querySelector('input[type="password"]');
  const bodyText = txt(doc.body).toLowerCase();
  const looksLoggedOut =
    hasPassword ||
    /\b(sign in|log in|login|create account)\b/.test(bodyText.slice(0, 500));
  return { hasPassword, looksLoggedOut, title: doc.title };
}

// Short text of every page heading so a missing or renamed section (e.g.
// optioncharts's "Puts" header turning into "Put Options (123)") shows up
// directly in the copy blob.
function headingsList(doc: Document): string[] {
  const els = Array.from(
    doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'),
  );
  const out: string[] = [];
  for (const el of els) {
    const t = txt(el);
    if (!t || t.length > 80) continue;
    out.push(t);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// Sample of div-grid rows for sites that render their data as ARIA grids
// instead of <table>. Captures header-ish rows + first few data rows so a
// non-table chain layout is visible without piercing shadow DOM.
function gridRowProbe(doc: Document): unknown[] {
  const rows = Array.from(doc.querySelectorAll('[role="row"]'));
  const out: unknown[] = [];
  for (const row of rows.slice(0, 10)) {
    const cells = Array.from(
      row.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"]'),
    ).map((c) => txt(c));
    out.push({ cells });
  }
  return out;
}

// All elements under `root`, descending into open shadow roots so that
// web-component / SPA content (e.g. StockOracle) is visible to keyword probes.
// A plain querySelectorAll does NOT pierce shadow boundaries, which is why an
// otherwise-populated SPA page can report zero matches.
function deepElements(root: ParentNode): Element[] {
  const out: Element[] = [];
  const visit = (node: ParentNode): void => {
    for (const el of Array.from(node.querySelectorAll("*"))) {
      if (out.length >= 5000) return; // safety cap
      out.push(el);
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) visit(sr);
    }
  };
  visit(root);
  return out;
}

// Elements whose text contains any keyword, with nearby context — useful for
// label-driven sites where values sit in sibling nodes.
function findByKeywords(doc: Document, keywords: string[]): unknown[] {
  const lower = keywords.map((k) => k.toLowerCase());
  const out: unknown[] = [];
  const els = deepElements(doc.body ?? doc);
  for (const el of els) {
    if (out.length >= MAX_ITEMS) break;
    if (el.children.length > 0) continue; // leaf nodes only
    const t = txt(el);
    if (!t || t.length > 60) continue;
    if (lower.some((k) => t.toLowerCase().includes(k))) {
      out.push({
        text: t,
        next: txt(el.nextElementSibling),
        parent: txt(el.parentElement).slice(0, 80),
      });
    }
  }
  return out;
}

export function collectDebug(
  source: SourceId,
  doc: Document,
): Record<string, unknown> {
  const base = { url: location.href, title: doc.title };
  try {
    switch (source) {
      case "yahoo_options":
        return {
          ...base,
          finStreamers: finStreamers(doc),
          tables: allTables(doc),
        };
      case "yahoo_vix":
        return { ...base, finStreamers: finStreamers(doc) };
      case "yahoo_analysis":
        return { ...base, tables: allTables(doc) };
      case "optioncharts":
        // Capture enough to diagnose a `0 greek records` miss without re-running
        // the extension: login/paywall state, every page heading (so a missing
        // "Puts" section is visible), table shapes (existing structure), any
        // div-grid rows (some sites moved chains off <table>), and a keyword
        // sweep for greek glyphs AND words so a header like "Δ" / "Greeks"
        // anywhere on the page is captured.
        return {
          ...base,
          login: loginState(doc),
          headings: headingsList(doc),
          tables: allTables(doc),
          gridRows: gridRowProbe(doc),
          metricLabels: findByKeywords(doc, [
            "IV Rank",
            "IV Percentile",
            "Implied Volatility",
            "Expected Move",
            "Put/Call",
          ]),
          greekHits: findByKeywords(doc, [
            "Strike",
            "Delta",
            "Gamma",
            "Theta",
            "Vega",
            "Greeks",
            "Δ",
            "Γ",
            "Θ",
            "ν",
            "Puts",
            "Calls",
          ]),
        };
      case "finviz":
      case "finviz_spy":
        return { ...base, snapshot: finvizMap(doc) };
      case "fred_t10y2y":
      case "fred_hyoas":
        return {
          ...base,
          observations: findByKeywords(doc, [
            "percent",
            "Last",
            "Updated",
            "Units",
          ]),
        };
      case "stockoracle":
        return {
          ...base,
          login: loginState(doc),
          intrinsicLabels: findByKeywords(doc, [
            "OracleValue",
            "Intrinsic",
            "Fair Value",
            "Margin of Safety",
            "Valuation",
          ]),
        };
      default: {
        const _exhaustive: never = source;
        return { ...base, note: `no probe for ${String(_exhaustive)}` };
      }
    }
  } catch (e) {
    return { ...base, probeError: e instanceof Error ? e.message : String(e) };
  }
}
