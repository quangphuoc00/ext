// Owner: Parser agent (yahoo). Source page:
//   yahoo_analysis -> https://ca.finance.yahoo.com/quote/<sym>/analysis/
import type {
  EstimatePeriod,
  Parser,
  YahooAnalysisData,
} from "@optionpilot/contracts";
import {
  asData,
  findTableAfterHeading,
  parseNumber,
  resolveSymbol,
  rowCells,
} from "./parseUtils";

// Map a table to { rowLabel(lowercased) -> per-period value cells }.
function rowMap(table: HTMLTableElement | null): {
  periods: string[];
  rows: Map<string, string[]>;
} {
  const rows = new Map<string, string[]>();
  if (!table) return { periods: [], rows };

  const trs = Array.from(table.querySelectorAll("tr"));
  if (trs.length === 0) return { periods: [], rows };

  const header = rowCells(trs[0]);
  const periods = header.slice(1);
  for (let i = 1; i < trs.length; i++) {
    const cells = rowCells(trs[i]);
    if (cells.length < 2) continue;
    rows.set(cells[0].toLowerCase(), cells.slice(1));
  }
  return { periods, rows };
}

function getRow(
  rows: Map<string, string[]>,
  re: RegExp,
): string[] | null {
  for (const [label, values] of rows) {
    if (re.test(label)) return values;
  }
  return null;
}

function buildEstimatePeriods(
  table: HTMLTableElement | null,
): EstimatePeriod[] {
  const { periods, rows } = rowMap(table);
  if (periods.length === 0) return [];

  const analysts = getRow(rows, /analyst/);
  const avg = getRow(rows, /avg|average/);
  const low = getRow(rows, /low/);
  const high = getRow(rows, /high/);

  return periods.map((period, idx) => ({
    period,
    numAnalysts: parseNumber(analysts?.[idx]),
    avgEstimate: parseNumber(avg?.[idx]),
    lowEstimate: parseNumber(low?.[idx]),
    highEstimate: parseNumber(high?.[idx]),
  }));
}

export const parseYahooAnalysis: Parser = (doc, ctx) => {
  try {
    const symbol = resolveSymbol(doc, ctx);
    if (!symbol) return null;

    const revenueEstimate = buildEstimatePeriods(
      findTableAfterHeading(doc, /revenue estimate/i),
    );
    const epsEstimate = buildEstimatePeriods(
      findTableAfterHeading(doc, /earnings estimate/i),
    );

    // EPS Revisions table: rows Up/Down Last 7/30 Days across the period columns.
    // The contract stores a single number per direction; we take the first
    // (Current Qtr) column. NOTE(phase2): confirm which column the lead wants.
    const { rows: revisionRows } = rowMap(
      findTableAfterHeading(doc, /eps revisions/i),
    );
    const revisionValue = (re: RegExp): number | null =>
      parseNumber(getRow(revisionRows, re)?.[0]);

    const epsRevisions = {
      up7: revisionValue(/up.*7/),
      up30: revisionValue(/up.*30/),
      down7: revisionValue(/down.*7/),
      down30: revisionValue(/down.*30/),
    };

    const hasAny =
      revenueEstimate.length > 0 ||
      epsEstimate.length > 0 ||
      epsRevisions.up7 != null ||
      epsRevisions.up30 != null ||
      epsRevisions.down7 != null ||
      epsRevisions.down30 != null;
    if (!hasAny) return null;

    const data: YahooAnalysisData = {
      revenueEstimate,
      epsEstimate,
      epsRevisions,
    };
    return {
      kind: "stock_json",
      symbol,
      column: "yahoo_analysis",
      data: asData(data),
    };
  } catch {
    return null;
  }
};
