// Frozen CSP analysis prompt. Mirrors peter-csp-check SKILL.md, adapted so the
// extension injects scraped data inline and Claude returns a parseable verdict.
// Formatted as Markdown for clearer reading by Claude.

import type { AnalysisMode } from "./database.types";

export interface PromptInput {
  symbol: string;
  mode: AnalysisMode;
  asOfDate: string; // ISO date of the scraped data
  totalAccountValue: number | null;
  cashAvailable: number | null;
  intrinsicValue: number | null;
  // Pre-serialized, human-readable scraped data blocks (already trimmed by caller).
  scraped: {
    yahooOptions?: string;
    optioncharts?: string;
    yahooAnalysis?: string;
    finviz?: string;
    macro?: string;
  };
}

const ROUTINE_CHECKLIST = `## Checklist - Routine

Items tagged **(GATE)** are hard no-go's: if one fails, the trade **FAILS**.
Items tagged **(SCORE)** are weighted confirmers used for the >= 80% pass rule.

### 1. Underlying selection
- **(GATE)** 1.1 Positive TTM net income
- **(GATE)** 1.2 Positive free cash flow (TTM)
- **(SCORE)** 1.3 Debt-to-equity < 1.5
- **(SCORE)** 1.4 Revenue growth >= 0% YoY
- **(GATE)** 1.5 Market cap > $10B
- **(SCORE)** 1.6 Beta between 0.5 and 1.5
- **(SCORE)** 1.7 Cash >= short-term debt, OR interest coverage > 3x
- **(GATE)** 1.8 Margin of safety: \`effective_basis <= intrinsic_value * 0.85\`

### 2. Liquidity
- **(GATE)** 2.1 Underlying average daily volume > 1,000,000 shares
- **(GATE)** 2.2 Open interest at candidate strike > 500 contracts
- **(GATE)** 2.3 Bid-ask spread ok (see formulas)

### 3. Volatility & timing
- **(GATE)** 3.1 IV Rank >= 20 (prefer >= 30)
- **(SCORE)** 3.2 No ex-dividend date inside the window

### 4. Strike & expiration
- **(GATE)** 4.1 Delta between 0.20 and 0.30 (from OptionCharts per-strike delta)
- **(SCORE)** 4.2 Strike >= 5% below current price
- **(SCORE)** 4.3 Strike at/below a marked technical support level (skip if no support is given as input -> unknown)
- **(GATE)** 4.4 DTE between 30 and 45 at entry

### 5. Return thresholds
- **(GATE)** 5.1 Annualized return >= 12%
- **(SCORE)** 5.2 Premium >= 1.2% of strike for ~30 DTE (\`premium_mid / strike >= 0.012\`)
- **(SCORE)** 5.3 Net premium >= 2x round-trip commissions (assume $2/contract round-trip; pass if \`premium_mid * 100 >= 4\`)

### 6. Position sizing & capital
Requires Total account value.

- **(GATE)** 6.1 100% of assignment cost held in cash (\`strike * 100 * contracts <= CSP cash available\`)
- **(GATE)** 6.2 Single-name notional if assigned <= 40% of total portfolio
- **(GATE)** 6.3 Sum of ALL CSP collateral <= 40% of total portfolio (assume only this trade for the analysis)
- **(GATE)** 6.4 No more than 2 open positions in same sector (assume true unless told otherwise)
- **(GATE)** 6.5 Effective cost basis acceptable (\`effective_basis < current_price\` AND \`margin_of_safety_ok\` from 1.8)

### 7. Management rules
Policies the trader commits to at entry; auto-pass and echo in \`risk_plan\`.

- **(GATE)** 7.1 Close at 50% of max profit
- **(GATE)** 7.2 Re-evaluate / roll at 21 DTE
- **(GATE)** 7.3 Breach plan defined (assignment-through-earnings handling)
- **(GATE)** 7.4 Loss cap: close at 2x credit received

### 8. Technical analysis
- **(SCORE)** 8.1 Price above 200-day SMA (Finviz SMA200 % is positive)
- **(SCORE)** 8.2 50-day SMA >= 200-day SMA (Finviz SMA50 % > Finviz SMA200 % means closer to 50d, not a comparison; treat as unknown unless absolute SMAs are provided)
- **(SCORE)** 8.3 Relative strength vs SPY positive (compare Finviz price-vs-SMA200 to SPY-vs-SMA200; AAPL/stock > SPY% passes)
- **(SCORE)** 8.4 RSI(14) between 35 and 65
- **(SCORE)** 8.5 Downside cushion >= 1x expected move (see formulas)
- **(SCORE)** 8.6 Price not within 5% of a fresh 52-week low (Finviz "52w low" % >= 5%)
- **(SCORE)** 8.7 No gap-down on rising volume in last 5 sessions (mark unknown unless intraday history provided)

### 9. News & catalysts
- **(GATE)** 9.1 Confirmed next-earnings date is at least 3 trading days AFTER expiration
- **(SCORE)** 9.2 Pre-decide assignment-through-earnings plan (auto-pass; echo in \`risk_plan\`)
- **(GATE)** 9.3 No binary catalyst in window (launch, FDA, ruling, investor day, guidance)
- **(SCORE)** 9.4 No major analyst downgrade in last 5 days
- **(GATE)** 9.5 Short interest < 15% of float
- **(GATE)** 9.6 No SEC inquiry / fraud / restatement / sudden exec exit in last 30 days
- **(SCORE)** 9.7 News sentiment neutral-to-positive

### 10. Macro
- **(SCORE)** 10.1 SPY above 200-day SMA (SPY vs 200-day SMA % > 0)
- **(GATE)** 10.2 VIX: < 20 normal pass; 20-30 pass with "reduce size" note; > 30 FAIL
- **(SCORE)** 10.3 No FOMC/CPI/jobs report inside the window you won't hold through
- **(SCORE)** 10.4 Sector ETF above 50-day SMA (mark unknown if no sector ETF data is provided)
- **(SCORE)** 10.5 10yr-2yr Treasury spread > -0.5 (not deeply inverted)
- **(GATE)** 10.6 High-yield credit spreads not widening sharply; FAIL if HY OAS > 500 bps`;

const DIP_BUY_CHECKLIST = `## Checklist - Dip-buy

Items tagged **(GATE)** are hard no-go's: if one fails, the trade **FAILS**.
Items tagged **(SCORE)** are weighted confirmers used for the >= 80% pass rule.

### 1. Underlying selection
- **(GATE)** 1.1 Positive TTM net income
- **(GATE)** 1.2 Positive free cash flow (TTM)
- **(SCORE)** 1.3 Debt-to-equity < 1.5
- **(SCORE)** 1.4 Revenue growth >= 0% YoY
- **(GATE)** 1.5 Market cap > $10B
- **(SCORE)** 1.6 Beta between 0.5 and 1.5
- **(SCORE)** 1.7 Cash >= short-term debt, OR interest coverage > 3x
- **(SCORE)** 1.8 Margin of safety: \`effective_basis <= intrinsic_value * 0.85\` (downgraded to SCORE in dip-buy)

### 2. Liquidity
- **(GATE)** 2.1 Underlying average daily volume > 1,000,000 shares
- **(GATE)** 2.2 Open interest at candidate strike > 500 contracts
- **(GATE)** 2.3 Bid-ask spread ok (see formulas)

### 3. Volatility & timing
- **(GATE)** 3.1 IV Rank >= 30 (prefer >= 50)
- **(SCORE)** 3.2 No ex-dividend date inside the window

### 4. Strike & expiration
- **(GATE)** 4.1 Delta between 0.20 and 0.30 (from OptionCharts per-strike delta)
- **(SCORE)** 4.2 Strike >= 5% below current price
- **(SCORE)** 4.3 Strike at/below a marked technical support level (skip if no support is given -> unknown)
- **(GATE)** 4.4 DTE between 30 and 45 at entry

### 5. Return thresholds
- **(GATE)** 5.1 Annualized return >= 20%
- **(SCORE)** 5.2 Premium >= 1.2% of strike for ~30 DTE
- **(SCORE)** 5.3 Net premium >= 2x round-trip commissions

### 6. Position sizing & capital
Requires Total account value.

- **(GATE)** 6.1 100% of assignment cost held in cash
- **(GATE)** 6.2 Single-name notional if assigned <= 40% of total portfolio
- **(GATE)** 6.3 Sum of ALL CSP collateral <= 40% of total portfolio
- **(GATE)** 6.4 No more than 2 open positions in same sector
- **(GATE)** 6.5 Effective cost basis acceptable
- **(SCORE)** 6.6 Sized smaller than a routine trade (acknowledge; auto-pass and echo in \`risk_plan\`)

### 7. Management rules
Policies; auto-pass and echo in \`risk_plan\`.

- **(GATE)** 7.1 Close at 50% of max profit
- **(GATE)** 7.2 Re-evaluate / roll at 21 DTE
- **(GATE)** 7.3 Breach plan defined
- **(GATE)** 7.4 Loss cap: close at 2x credit received

### 8. Technical analysis
- **(SCORE)** 8.1 Price above 200-day SMA
- **(SCORE)** 8.2 50-day SMA >= 200-day SMA (unknown unless absolute SMAs are provided)
- **(SCORE)** 8.4 RSI(14) between 35 and 65 (may dip below 35 on a single gap)
- **(SCORE)** 8.5 Downside cushion >= 1x expected move
- **(SCORE)** 8.7 No gap-down on rising volume in last 5 sessions (in dip-buy: the gap IS the setup, so auto-pass and note it)

### 9. News & catalysts
- **(GATE)** 9.1 Confirmed next-earnings date is at least 3 trading days AFTER expiration
- **(SCORE)** 9.2 Pre-decide assignment-through-earnings plan (auto-pass; echo in \`risk_plan\`)
- **(GATE)** 9.3 No binary catalyst in window
- **(GATE)** 9.5 Short interest < 15% of float
- **(GATE)** 9.6 No SEC inquiry / fraud / restatement / sudden exec exit in last 30 days
- **(SCORE)** 9.7 News sentiment neutral-to-positive
- **(SCORE)** 9.8 Price fell more than fundamentals (dip-buy thesis)
- **(GATE)** 9.9 Catalyst causing the dip is transient, not structural

### 10. Macro
- **(SCORE)** 10.1 SPY above 200-day SMA
- **(GATE)** 10.2 VIX: < 20 normal; 20-30 pass with "reduce size"; > 30 FAIL
- **(SCORE)** 10.3 No FOMC/CPI/jobs report inside the window you won't hold through
- **(SCORE)** 10.4 Sector ETF above 50-day SMA (unknown if not provided)
- **(SCORE)** 10.5 10yr-2yr Treasury spread > -0.5
- **(GATE)** 10.6 High-yield credit spreads not widening sharply; FAIL if HY OAS > 500 bps
- **(SCORE)** 10.7 Large share of the drop is explainable as beta * index move`;

const RULES_OF_EVIDENCE = `## Rules of evidence:

1. Use the scraped data below as the source of truth. Do **NOT** re-fetch numbers already given (price, IV, OI, fundamentals, technicals, macro).
2. Browsing is allowed **ONLY** to confirm items where the scraped data is silent: next earnings date, binary catalysts (launch / FDA / ruling / investor day / guidance), SEC / fraud / restatement / sudden exec exits, analyst downgrades, news sentiment. Budget: at most one lookup per item.
3. **Unknown GATE -> FAILS.** Unknown **SCORE** -> counts as NOT passed toward the 80% threshold. Add every unknown item id to the JSON \`unknowns\` array.
4. **Data sanity:** if all bid/ask in the chain are 0, or all OI are 0, or every per-strike IV is suspicious (clean powers of two like 50% / 25% / 12.5% / 6.3% / 0%), treat that metric as unreliable (NOT as a real zero). Prefer \`IV30d\` from OptionCharts for IV math.`;

const FORMULAS = `## Formulas

Use these exactly; do not improvise.

- \`premium_mid\`       = \`(bid + ask) / 2\`. If \`bid == 0\` AND \`ask == 0\`, \`premium_mid\` is **UNKNOWN** (do NOT fall back to "last").
- \`DTE\`               = calendar days from "as-of date" to the option expiry.
- \`annualized_return\` = \`(premium_mid / strike) * (365 / DTE)\`.
- \`effective_basis\`   = \`strike - premium_mid\`.
- \`margin_of_safety_ok\` = \`effective_basis <= intrinsic_value * (1 - 0.15)\`.
- \`expected_move\`     = \`current_price * IV30d * sqrt(DTE / 365)\`.
- \`downside_cushion\`  = \`current_price - strike\`. Cushion check passes when \`downside_cushion >= expected_move\`.
- \`strike_5pct_below\` = \`strike <= current_price * 0.95\`.
- \`bid_ask_spread_ok\` = \`(ask - bid) <= max($0.10, 0.10 * premium_mid)\`.`;

const PRECHECK = `## Data sufficiency precheck

Run **BEFORE** evaluating any GATE.

- **A.** Options chain must contain at least one expiry with \`30 <= DTE <= 45\`. If not -> **STOP**, \`verdict = FAIL\`, \`why = "no expiry in DTE 30-45 window"\`.
- **B.** At the candidate expiry, bid/ask must not be all 0 AND OI must not be all 0. If they are -> **STOP**, \`verdict = FAIL\`, \`why = "options chain data unusable (bid/ask or OI all zero)"\`.
- **C.** Next-earnings date must be provided OR confirmable in one browse. If not -> **STOP**, \`verdict = FAIL\`, \`why = "next earnings date could not be confirmed"\`.
- **D.** If "Total account value" is unknown, GATEs 6.1-6.3 are unknown -> they **FAIL** (per rule 3).

When stopping, still emit the full JSON block with \`verdict = FAIL\`, fill \`blocking_issues\`, and list missing fields in \`unknowns\`.`;

const STRIKE_SELECTION = `## Strike selection

Only run if every GATE passes and \`score_pct >= 0.80\`.

1. Filter the chain to expirations with \`30 <= DTE <= 45\`.
2. From those, keep strikes with delta in \`[0.20, 0.30]\`.
3. Keep strikes where \`margin_of_safety_ok\` is true (skip this filter in dip-buy mode, where 1.8 is a SCORE).
4. Keep strikes where \`bid_ask_spread_ok\` is true and \`OI > 500\`.
5. Among survivors, pick the one with the highest \`annualized_return\` that still satisfies the mode's annualized return GATE (Routine \`>= 12%\`, Dip-buy \`>= 20%\`).
6. If no strike survives -> \`verdict = FAIL\`, \`recommended_strike = null\`, \`recommended_expiry = null\`, \`why = "no strike satisfies all entry filters"\`.`;

function checklistFor(mode: AnalysisMode): string {
  return mode === "dip_buy" ? DIP_BUY_CHECKLIST : ROUTINE_CHECKLIST;
}

function block(title: string, body?: string): string {
  if (!body || !body.trim()) return `### ${title}\n(not available - treat dependent items as unknown)\n`;
  return `### ${title}\n${body.trim()}\n`;
}

export function buildPrompt(input: PromptInput): string {
  const {
    symbol,
    mode,
    asOfDate,
    totalAccountValue,
    cashAvailable,
    intrinsicValue,
    scraped,
  } = input;

  const modeLabel = mode === "dip_buy" ? "Dip-buy" : "Routine";
  const upperSymbol = symbol.toUpperCase();

  return `# Cash-Secured Put (CSP) Analysis - ${upperSymbol}

You are evaluating whether to sell a cash-secured put (CSP) on **${upperSymbol}**.

- **Mode:** ${modeLabel}. Apply **ONLY** this mode's thresholds; ignore anything tagged for the other mode.
- **As-of date:** \`${asOfDate}\`. Echo this date in the \`why\` field of the JSON output.

${RULES_OF_EVIDENCE}

${FORMULAS}

${PRECHECK}

## Pass rule

\`verdict = PASS\` iff **all** of:
1. The precheck passes.
2. **Every** GATE passes.
3. \`score_pct\` (\`score_pass / score_total\`) \`>= 0.80\`.

Otherwise \`verdict = FAIL\`.

## Portfolio context

- **Total account value:** ${totalAccountValue ?? "unknown"}
- **CSP cash available:** ${cashAvailable ?? "unknown"}
- **Trusted intrinsic value:** ${intrinsicValue ?? "unknown"}

${checklistFor(mode)}

${STRIKE_SELECTION}

## Scraped data (as of ${asOfDate})

${block("Yahoo options chain (price, strikes, bid/ask, OI, IV)", scraped.yahooOptions)}
${block("OptionCharts (IV Rank/Percentile, expected move, per-strike Delta)", scraped.optioncharts)}
${block("Yahoo analysis (revenue/EPS estimates, EPS revisions)", scraped.yahooAnalysis)}
${block("Finviz (fundamentals/technicals)", scraped.finviz)}
${block("Macro (VIX, 10y-2y spread, HY OAS, SPY 200-SMA)", scraped.macro)}

## Output

First show your work as a compact markdown table with three columns: \`item id\`, \`result\` (\`pass\` | \`fail\` | \`unknown\`), \`one-line reason\`. Group GATE rows first, then SCORE rows. Then state \`score_pass / score_total\` and the final verdict.

As the **LAST** thing in your reply, output a single fenced JSON code block (and **nothing** after it) with exactly this shape:

\`\`\`json
{
  "verdict": "PASS" | "FAIL",
  "mode": "${modeLabel}",
  "as_of": "${asOfDate}",
  "data_ok": true,
  "blocking_issues": ["<reasons the precheck stopped, or empty>"],
  "gate_results": [
    {"id": "1.1", "name": "Positive TTM net income", "result": "pass" | "fail" | "unknown", "note": "<short>"}
  ],
  "score_results": [
    {"id": "1.3", "name": "Debt-to-equity < 1.5", "result": "pass" | "fail" | "unknown", "note": "<short>"}
  ],
  "score_pass": <integer>,
  "score_total": <integer>,
  "score_pct": <number 0..1>,
  "recommended_strike": <number or null>,
  "recommended_expiry": "<YYYY-MM-DD or null>",
  "recommended_premium_mid": <number or null>,
  "annualized_return": <number or null>,
  "risk_plan": {
    "close_at_50pct_profit": true,
    "reevaluate_at_21_dte": true,
    "loss_cap_2x_credit": true,
    "breach_plan": "<short description>"
  },
  "why": "<one sentence including the as-of date>",
  "decision": "<short final decision line>",
  "unknowns": ["<checklist item ids you could not confirm>"]
}
\`\`\``;
}
