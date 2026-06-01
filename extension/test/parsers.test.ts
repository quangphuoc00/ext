// L7 - Parser correctness against real captured fixtures (public sources).
// Assertions check shape + sane ranges (fixtures are point-in-time, so we avoid
// pinning exact live values) and the defensive null path on a blank document.
import { describe, expect, it } from "vitest";
import type { ScrapeWrite } from "@optionpilot/contracts";
import { getParser } from "../src/content/registry";
import { blankDoc, docFromFixture } from "./helpers";

function asJson(w: ScrapeWrite | null) {
  expect(w).not.toBeNull();
  if (w?.kind !== "stock_json") throw new Error(`expected stock_json, got ${w?.kind}`);
  return w;
}
function asMacro(w: ScrapeWrite | null) {
  expect(w).not.toBeNull();
  if (w?.kind !== "macro") throw new Error(`expected macro, got ${w?.kind}`);
  return w;
}

describe("finviz", () => {
  it("parses price/beta/rsi for AAPL", () => {
    const w = asJson(getParser("finviz")(docFromFixture("finviz.html"), { symbol: "AAPL" }));
    expect(w.column).toBe("finviz");
    expect(w.symbol).toBe("AAPL");
    const d = w.data as Record<string, number | null>;
    expect(typeof d.price).toBe("number");
    expect(d.price as number).toBeGreaterThan(50);
    expect(d.price as number).toBeLessThan(5000);
    expect(d.rsi14 as number).toBeGreaterThanOrEqual(0);
    expect(d.rsi14 as number).toBeLessThanOrEqual(100);
    expect(typeof d.beta).toBe("number");
  });
  it("returns null on a blank document", () => {
    expect(getParser("finviz")(blankDoc(), { symbol: "AAPL" })).toBeNull();
  });
});

describe("finviz_spy (macro spy_sma200)", () => {
  it("parses a finite spy_sma200", () => {
    const w = asMacro(getParser("finviz_spy")(docFromFixture("finviz_spy.html"), {}));
    expect(w.metric).toBe("spy_sma200");
    expect(Number.isFinite(w.value)).toBe(true);
  });
  it("returns null on a blank document", () => {
    expect(getParser("finviz_spy")(blankDoc(), {})).toBeNull();
  });
});

describe("yahoo_options", () => {
  it("parses underlying price + put chain for AAPL", () => {
    const w = asJson(
      getParser("yahoo_options")(docFromFixture("yahoo_options.html", "https://ca.finance.yahoo.com/quote/AAPL/options/"), { symbol: "AAPL" }),
    );
    expect(w.column).toBe("yahoo_options");
    const d = w.data as { price: number | null; expirations: { expiry: string; puts: { strike: number }[] }[] };
    expect(d.price as number).toBeGreaterThan(50);
    expect(d.price as number).toBeLessThan(5000);
    expect(d.expirations.length).toBeGreaterThanOrEqual(1);
    const puts = d.expirations[0].puts;
    expect(puts.length).toBeGreaterThan(0);
    expect(puts[0].strike).toBeGreaterThan(0);
  });
  it("returns null on a blank document", () => {
    expect(getParser("yahoo_options")(blankDoc(), { symbol: "AAPL" })).toBeNull();
  });
});

describe("yahoo_analysis", () => {
  it("parses EPS/revenue estimate periods for AAPL", () => {
    const w = asJson(getParser("yahoo_analysis")(docFromFixture("yahoo_analysis.html"), { symbol: "AAPL" }));
    expect(w.column).toBe("yahoo_analysis");
    const d = w.data as { epsEstimate: unknown[]; revenueEstimate: unknown[] };
    expect(d.epsEstimate.length + d.revenueEstimate.length).toBeGreaterThan(0);
  });
  it("returns null on a blank document", () => {
    expect(getParser("yahoo_analysis")(blankDoc(), { symbol: "AAPL" })).toBeNull();
  });
});

describe("yahoo_vix (macro)", () => {
  it("parses a sane VIX value (5..150) — regression guard for the BTC-USD bug", () => {
    const w = asMacro(getParser("yahoo_vix")(docFromFixture("yahoo_vix.html", "https://ca.finance.yahoo.com/quote/%5EVIX/"), {}));
    expect(w.metric).toBe("vix");
    expect(w.value).toBeGreaterThan(5);
    expect(w.value).toBeLessThan(150);
  });
  it("returns null on a blank document", () => {
    expect(getParser("yahoo_vix")(blankDoc(), {})).toBeNull();
  });
});

describe("optioncharts", () => {
  it("parses overview metrics for AAPL and flags greeks as paywalled when the chain is gated", () => {
    const w = asJson(
      getParser("optioncharts")(
        docFromFixture("optioncharts.html", "https://optioncharts.io/options/AAPL"),
        { symbol: "AAPL" },
      ),
    );
    expect(w.column).toBe("optioncharts");
    expect(w.symbol).toBe("AAPL");
    const d = w.data as {
      ivRank: number | null;
      ivPercentile: number | null;
      iv30d: number | null;
      expectedMove: number | null;
      putCallRatio: number | null;
      greeks: { strike: number; delta: number | null }[];
      greeksPaywalled?: boolean;
    };
    // Captured fixture is the free tier, so the per-strike greeks chain sits
    // behind the upgrade interstitial. The parser must detect this and skip
    // the doomed table search instead of silently returning `0 greek records`.
    expect(d.greeksPaywalled).toBe(true);
    expect(d.greeks).toEqual([]);
    // Overview metrics render outside the paywall and must still come through.
    expect(typeof d.ivRank).toBe("number");
    expect(d.ivRank as number).toBeGreaterThanOrEqual(0);
    expect(d.ivRank as number).toBeLessThanOrEqual(100);
    expect(typeof d.iv30d).toBe("number");
    expect(d.iv30d as number).toBeGreaterThan(0);
    expect(d.iv30d as number).toBeLessThan(5); // fraction, not percent
  });
  it("returns null on a blank document", () => {
    expect(getParser("optioncharts")(blankDoc(), { symbol: "AAPL" })).toBeNull();
  });
});

describe("FRED", () => {
  it("parses t10y2y with an as-of date", () => {
    const w = asMacro(getParser("fred_t10y2y")(docFromFixture("fred_t10y2y.html"), {}));
    expect(w.metric).toBe("t10y2y");
    expect(Number.isFinite(w.value)).toBe(true);
    expect(w.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("parses hy_oas", () => {
    const w = asMacro(getParser("fred_hyoas")(docFromFixture("fred_hyoas.html"), {}));
    expect(w.metric).toBe("hy_oas");
    expect(w.value).toBeGreaterThan(0);
    expect(w.value).toBeLessThan(50);
  });
  it("returns null on a blank document", () => {
    expect(getParser("fred_t10y2y")(blankDoc(), {})).toBeNull();
  });
});
