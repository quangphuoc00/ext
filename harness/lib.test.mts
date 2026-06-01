// L10 - Harness behavior (pure parts): job planning, symbol dedupe, persist mapping.
import { describe, expect, it } from "vitest";
import type { ScrapeWrite } from "@optionpilot/contracts";
import { buildPersistOp, dedupeSymbols, planJobs } from "./lib.mts";

describe("planJobs", () => {
  it("macro-only -> 4 macro jobs, no per-symbol jobs", () => {
    const jobs = planJobs({ symbols: [], macro: true, macroOnly: true });
    expect(jobs.length).toBe(4);
    expect(jobs.every((j) => !j.symbol)).toBe(true);
  });

  it("no-macro + one symbol -> 3 per-symbol jobs only", () => {
    const jobs = planJobs({ symbols: ["AAPL"], macro: false, macroOnly: false });
    expect(jobs.length).toBe(3);
    expect(jobs.every((j) => j.symbol === "AAPL")).toBe(true);
  });

  it("macro + two symbols -> 4 macro + 2*3 per-symbol = 10", () => {
    const jobs = planJobs({ symbols: ["AAPL", "TSLA"], macro: true, macroOnly: false });
    expect(jobs.length).toBe(10);
  });
});

describe("dedupeSymbols", () => {
  it("uppercases, trims, drops empties, and de-duplicates", () => {
    expect(dedupeSymbols(["aapl", " aapl ", "TSLA", null, "", undefined, "tsla"])).toEqual(["AAPL", "TSLA"]);
  });
});

describe("buildPersistOp", () => {
  const NOW = "2026-05-31T00:00:00.000Z";

  it("maps macro writes to macro_data upsert keyed on metric", () => {
    const w: ScrapeWrite = { kind: "macro", metric: "vix", value: 15.32, asOf: "2026-05-30" };
    const op = buildPersistOp(w, NOW);
    expect(op.table).toBe("macro_data");
    expect(op.onConflict).toBe("metric");
    expect(op.row).toMatchObject({ metric: "vix", value: 15.32, as_of: "2026-05-30", updated_at: NOW });
  });

  it("maps stock_json to the right column + its *_updated_at, keyed on symbol", () => {
    const w: ScrapeWrite = { kind: "stock_json", symbol: "aapl", column: "finviz", data: { price: 312 } };
    const op = buildPersistOp(w, NOW);
    expect(op.table).toBe("stocks");
    expect(op.onConflict).toBe("symbol");
    expect(op.row.symbol).toBe("AAPL");
    expect(op.row.finviz).toEqual({ price: 312 });
    expect(op.row.finviz_updated_at).toBe(NOW);
  });

  it("maps stock_intrinsic to intrinsic_value + intrinsic_updated_at", () => {
    const w: ScrapeWrite = { kind: "stock_intrinsic", symbol: "AAPL", value: 180.5 };
    const op = buildPersistOp(w, NOW);
    expect(op.table).toBe("stocks");
    expect(op.row).toMatchObject({ symbol: "AAPL", intrinsic_value: 180.5, intrinsic_updated_at: NOW });
  });
});
