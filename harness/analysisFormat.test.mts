// L7 - analysisFormat behaviour. Verifies the serializers that feed Claude:
// expiry window prioritization, market-state warnings, IV/OI column stripping,
// HY OAS unit conversion, and earnings-date past/future tagging. Run:
//   npm --prefix harness test
import { describe, expect, it } from "vitest";
import type { YahooOptionsData } from "@optionpilot/contracts";
import {
  daysBetween,
  formatFinviz,
  formatMacro,
  formatOptioncharts,
  formatYahooOptions,
} from "../extension/src/background/analysisFormat";

// Helpers ----------------------------------------------------------------

interface PutLike {
  strike: number;
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  last?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  iv?: number | null;
}

function makePuts(strike: number, overrides: Partial<PutLike> = {}): PutLike {
  return {
    strike,
    bid: 1.0,
    ask: 1.2,
    mid: 1.1,
    last: 1.1,
    volume: 100,
    openInterest: 500,
    iv: 0.21,
    ...overrides,
  };
}

function makeChain(
  expiries: { expiry: string; puts?: PutLike[] }[],
  extra: Partial<YahooOptionsData> = {},
): YahooOptionsData {
  return {
    price: 632.51,
    expirations: expiries.map((e) => ({
      expiry: e.expiry,
      puts: (e.puts ?? [makePuts(600), makePuts(605), makePuts(610)]) as YahooOptionsData["expirations"][number]["puts"],
    })),
    ...extra,
  };
}

// daysBetween ------------------------------------------------------------

describe("daysBetween", () => {
  it("returns calendar-day delta in UTC", () => {
    expect(daysBetween("2026-06-01", "2026-07-17")).toBe(46);
    expect(daysBetween("2026-06-01", "2026-06-01")).toBe(0);
    expect(daysBetween("2026-06-01", "2026-05-30")).toBe(-2);
  });

  it("returns null on unparseable input", () => {
    expect(daysBetween("nope", "2026-06-01")).toBeNull();
    expect(daysBetween("2026-06-01", "nope")).toBeNull();
  });
});

// formatYahooOptions: expiry window prioritization -----------------------

describe("formatYahooOptions expiry selection", () => {
  it("keeps the 30-45 DTE expiry even when 12 near-term weeklies are present", () => {
    // Reproduces the META 2026-06-01 case: many near-term weeklies + one
    // July monthly at DTE=46 (just outside the [20, 60] window) plus an
    // in-window July monthly at DTE=38. The selector must NOT slice off
    // the in-window one to keep room for weeklies.
    const chain = makeChain([
      { expiry: "2026-06-01" }, // DTE=0
      { expiry: "2026-06-03" }, // DTE=2
      { expiry: "2026-06-05" }, // DTE=4
      { expiry: "2026-06-08" }, // DTE=7
      { expiry: "2026-06-10" }, // DTE=9
      { expiry: "2026-06-12" }, // DTE=11
      { expiry: "2026-06-18" }, // DTE=17
      { expiry: "2026-06-26" }, // DTE=25 (in window)
      { expiry: "2026-07-02" }, // DTE=31 (in window) - the one Claude needs
      { expiry: "2026-07-09" }, // DTE=38 (in window)
      { expiry: "2026-07-17" }, // DTE=46 (out of window)
      { expiry: "2026-08-21" }, // DTE=81 (out of window)
    ]);

    const out = formatYahooOptions(chain, "2026-06-01");
    expect(out).toBeDefined();
    // The 30-45 DTE expiry must appear in the rendered block.
    expect(out).toContain("2026-07-02");
    expect(out).toContain("DTE=31");
    expect(out).toContain("2026-07-09");
    expect(out).toContain("DTE=38");
    // 2026-06-26 (DTE=25) is in the 20-60 window so it must survive too.
    expect(out).toContain("2026-06-26");
  });

  it("emits DTE inline for every rendered expiry", () => {
    const out = formatYahooOptions(
      makeChain([{ expiry: "2026-07-17" }]),
      "2026-06-01",
    );
    expect(out).toMatch(/Expiry 2026-07-17 \(DTE=46\) \(puts\):/);
  });
});

// formatYahooOptions: market state ---------------------------------------

describe("formatYahooOptions market state", () => {
  it("prepends a WARNING banner when marketState is CLOSED", () => {
    const chain = makeChain([{ expiry: "2026-07-09" }], {
      marketState: "CLOSED",
    });
    const out = formatYahooOptions(chain, "2026-06-01");
    expect(out).toContain("WARNING: snapshot taken while market state = CLOSED");
  });

  it("derives marketState=CLOSED when every bid+ask in the chain is 0", () => {
    const zeroPuts = [makePuts(600, { bid: 0, ask: 0 }), makePuts(605, { bid: 0, ask: 0 })];
    const chain = makeChain([{ expiry: "2026-07-09", puts: zeroPuts }]);
    // marketState left undefined - the formatter must infer it.
    const out = formatYahooOptions(chain, "2026-06-01");
    expect(out).toContain("WARNING: snapshot taken while market state = CLOSED");
  });

  it("does not warn when marketState is REGULAR", () => {
    const chain = makeChain([{ expiry: "2026-07-09" }], {
      marketState: "REGULAR",
    });
    const out = formatYahooOptions(chain, "2026-06-01");
    expect(out).not.toContain("WARNING");
  });
});

// formatYahooOptions: column stripping -----------------------------------

describe("formatYahooOptions column stripping", () => {
  it("drops the IV column when every value falls on Yahoo's power-of-two buckets", () => {
    const bucketed = [
      makePuts(600, { iv: 0.5 }),   // 50.0%
      makePuts(605, { iv: 0.25 }),  // 25.0%
      makePuts(610, { iv: 0.125 }), // 12.5%
      makePuts(615, { iv: 0.063 }), // 6.3%
    ];
    const out = formatYahooOptions(
      makeChain([{ expiry: "2026-07-17", puts: bucketed }]),
      "2026-06-01",
    );
    expect(out).toContain("Note: per-strike IV unreliable");
    expect(out).not.toMatch(/\| IV\n/);
  });

  it("keeps the IV column when at least one value falls outside the buckets", () => {
    const mixed = [
      makePuts(600, { iv: 0.5 }),
      makePuts(605, { iv: 0.234 }), // not a bucket
    ];
    const out = formatYahooOptions(
      makeChain([{ expiry: "2026-07-17", puts: mixed }]),
      "2026-06-01",
    );
    expect(out).not.toContain("per-strike IV unreliable");
  });

  it("drops the OI column when every openInterest is 0", () => {
    const zeroOi = [
      makePuts(600, { openInterest: 0 }),
      makePuts(605, { openInterest: 0 }),
      makePuts(610, { openInterest: 0, iv: 0.234 }),
    ];
    const out = formatYahooOptions(
      makeChain([{ expiry: "2026-07-17", puts: zeroOi }]),
      "2026-06-01",
    );
    expect(out).toContain("Note: per-strike OI unreliable");
  });
});

// formatMacro ------------------------------------------------------------

describe("formatMacro", () => {
  it("converts hy_oas from percent to bps and leaves other metrics alone", () => {
    const out = formatMacro([
      { metric: "hy_oas", value: 2.72, as_of: "2026-05-28" },
      { metric: "t10y2y", value: 0.47, as_of: "2026-05-29" },
      { metric: "vix", value: 15.32, as_of: null },
      { metric: "spy_sma200", value: 11.06, as_of: null },
    ]);
    expect(out).toContain("High-yield OAS (bps): 272 (as of 2026-05-28)");
    expect(out).toContain("10yr-2yr Treasury spread: 0.47");
    expect(out).toContain("VIX: 15.32");
    expect(out).toContain("SPY vs 200-day SMA (%): 11.06");
  });

  it("converts hy_oas 6.31% to 631 bps so the GATE >500 threshold actually trips", () => {
    const out = formatMacro([{ metric: "hy_oas", value: 6.31, as_of: null }]);
    expect(out).toContain("High-yield OAS (bps): 631");
  });
});

// formatFinviz -----------------------------------------------------------

describe("formatFinviz earnings tagging", () => {
  const base = {
    price: 632.51,
    marketCap: 1.6e12,
    beta: 1.23,
    debtEq: 0.36,
    shortFloat: 1.47,
    avgVolume: 15_680_000,
    volume: 19_658_331,
    rsi14: 55.36,
    sma20: 3.13,
    sma50: 2.26,
    sma200: -5.11,
    high52w: -20.56,
    low52w: 21.58,
    sector: "Communication Services",
    industry: "Internet Content & Information",
    epsTtm: 27.51,
    roe: 32.93,
    pe: 22.99,
  };

  it("tags a past earnings date as LAST quarter", () => {
    const out = formatFinviz(
      { ...base, earningsDate: "Apr 29 AMC" },
      "2026-06-01",
    );
    expect(out).toContain(
      "Earnings date: Apr 29 AMC (LAST quarter - next earnings not yet posted; browse to confirm)",
    );
  });

  it("does not tag a future earnings date", () => {
    const out = formatFinviz(
      { ...base, earningsDate: "Aug 5 AMC" },
      "2026-06-01",
    );
    expect(out).toContain("Earnings date: Aug 5 AMC");
    expect(out).not.toContain("LAST quarter");
  });

  it("leaves the line untagged when earningsDate is null", () => {
    const out = formatFinviz({ ...base, earningsDate: null }, "2026-06-01");
    expect(out).toContain("Earnings date: ?");
    expect(out).not.toContain("LAST quarter");
  });
});

// formatOptioncharts: expected move fallback ----------------------------

describe("formatOptioncharts expectedMove fallback", () => {
  it("computes a dollar move from iv30d * price * sqrt(30/365) when expectedMove is missing", () => {
    const out = formatOptioncharts(
      {
        ivRank: 31.33,
        ivPercentile: 41.27,
        iv30d: 0.31,
        expectedMove: null,
        putCallRatio: 0.3,
        greeks: [],
      },
      632.51,
    );
    expect(out).toContain("computed: price * iv30d * sqrt(30/365)");
    // 632.51 * 0.31 * sqrt(30/365) ~ 56.21
    expect(out).toMatch(/Expected move: 56\.\d+/);
  });

  it("uses the scraped expectedMove unchanged when present", () => {
    const out = formatOptioncharts(
      {
        ivRank: 31.33,
        ivPercentile: 41.27,
        iv30d: 0.31,
        expectedMove: 15.5,
        putCallRatio: 0.3,
        greeks: [],
      },
      632.51,
    );
    expect(out).toContain("Expected move: 15.50");
    expect(out).not.toContain("computed");
  });
});
