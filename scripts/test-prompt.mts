// L6 - prompt builder checks. Run: npx tsx scripts/test-prompt.mts
import { buildPrompt } from "../contracts/src/index";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

const out = buildPrompt({
  symbol: "aapl",
  mode: "routine",
  asOfDate: "2026-05-31",
  totalAccountValue: 500000,
  cashAvailable: 100000,
  intrinsicValue: 180.5,
  scraped: {
    finviz: "Price: 200, RSI: 55",
    optioncharts: "IV Rank: 35",
    // yahooOptions, yahooAnalysis, macro intentionally omitted
  },
});

check("includes uppercased symbol AAPL", out.includes("AAPL"));
check("declares Routine mode", out.includes("Routine"));
check("includes as-of date", out.includes("2026-05-31"));
check("includes account value", out.includes("500000"));
check("includes intrinsic value", out.includes("180.5"));
check("injects finviz block content", out.includes("Price: 200, RSI: 55"));
check("injects optioncharts block content", out.includes("IV Rank: 35"));
check("marks omitted block not available", out.includes("not available"));
check("requires JSON verdict contract", out.includes('"verdict"') && out.includes('"score_pass"'));
check("includes ```json fence", out.includes("```json"));

// --- new optimized sections must be present in the rendered prompt ---
check("renders Rules of evidence section", out.includes("Rules of evidence:"));
check("renders Formulas section with annualized_return", out.includes("annualized_return"));
check("renders Data sufficiency precheck", out.includes("Data sufficiency precheck"));
check("renders Strike selection algorithm", out.includes("Strike selection"));
check("locks margin of safety to *0.85 multiplier", out.includes("intrinsic_value * (1 - 0.15)"));
check("includes expanded JSON keys (data_ok, gate_results, risk_plan)",
  out.includes('"data_ok"') && out.includes('"gate_results"') && out.includes('"risk_plan"'));
check("emits mode-specific Routine annualized return threshold", out.includes("Annualized return >= 12%"));
check("routine prompt does NOT include dip-buy 'the gap IS the setup' note",
  !out.includes("the gap IS the setup"));
check("routine prompt does NOT include 'Price fell more than fundamentals'",
  !out.includes("Price fell more than fundamentals"));
check("routine prompt does NOT include the 'beta * index move' dip-buy clause",
  !out.includes("beta * index move"));

// --- precheck B' (market state) addendum must be present ---
check("renders precheck B' marketState rule",
  out.includes("WARNING: snapshot taken while market state ="));

const dip = buildPrompt({
  symbol: "msft",
  mode: "dip_buy",
  asOfDate: "2026-05-31",
  totalAccountValue: null,
  cashAvailable: null,
  intrinsicValue: null,
  scraped: {},
});
check("dip_buy mode labelled Dip-buy", dip.includes("Dip-buy"));
check("null account value renders 'unknown'", dip.includes("unknown"));
check("dip_buy uses 20% annualized return GATE", dip.includes("Annualized return >= 20%"));
check("dip_buy uses 30 IV Rank GATE", dip.includes("IV Rank >= 30"));
check("dip_buy downgrades margin of safety to SCORE",
  dip.includes("downgraded to SCORE in dip-buy"));
check("dip_buy includes dip-buy-only items (price fell more than fundamentals)",
  dip.includes("Price fell more than fundamentals"));
check("dip_buy does NOT include Routine annualized return threshold",
  !dip.includes("Annualized return >= 12%"));

console.log(failures === 0 ? "\nL6 ALL PASS" : `\nL6 ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
