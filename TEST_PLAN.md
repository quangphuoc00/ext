# OptionPilot - test plan

A standing plan to verify core features. Ask me to "run the test plan" and I'll execute
every test myself and report PASS/FAIL with evidence. Every layer here runs fully
autonomously — no manual steps from you.

## Tools I can use autonomously
- File/build tools (`tsc`, `vite build`, `next build`).
- Supabase Management API with the stored access token (run SQL, seed/read/cleanup data).
- The dashboard dev server at http://localhost:3000.
- The in-IDE browser (navigate, fill, click, snapshot, console, network) — for the dashboard
  and for public web pages.
- The `harness/` runner (Playwright + jsdom) — drives the same parser contracts headlessly
  against the public sources and writes to Supabase, with no extension involved.

## Feasibility legend
- **AUTO** — I can run end-to-end now, no help needed.
- **AUTO+SEED** — AUTO; I first seed rows via the Management API to simulate the extension.
- **NEEDS-CHANGE** — needs new tooling/fixtures added before it can run (noted inline).

## Scope
This plan covers only what runs fully autonomously. The login-gated sources
(optioncharts, stockoracle), the claude.ai analysis flow, and the extension-only
runtime/popup behaviors are intentionally out of scope here.

---

## L0 - Static / build  (AUTO)
- T0.1 `contracts` `tsc --noEmit` clean.
- T0.2 `extension` `tsc --noEmit` + `vite build` succeed.
- T0.3 `dashboard` `next build` succeeds.
Expected: all exit 0.

## L1 - Database schema & security  (AUTO)
- T1.1 All 8 public tables exist (profiles, stocks, macro_data, watchlist, portfolio, analyses, analysis_requests, scrape_requests).
- T1.2 RLS enabled on all 8; expected policies present (owner-only on personal, authenticated read/write on stocks+macro).
- T1.3 `handle_new_user` trigger exists on auth.users; `set_updated_at` triggers on profiles/stocks/macro/portfolio.
- T1.4 Realtime publication `supabase_realtime` includes the 7 expected tables.
- T1.5 Negative RLS: a second user cannot read user A's watchlist/portfolio rows (simulate with two user_ids; verify policy via SQL `set role`/JWT claim check or by querying with explicit user filters).
- T1.6 Constraint / integrity (insert-invalid via API must be rejected):
  - `portfolio.contracts > 0` (insert 0/-1 rejected); `portfolio.status` not in enum rejected.
  - `analyses.mode`/`analyses.verdict` outside enum rejected.
  - `analysis_requests.status` / `scrape_requests.status` outside enum rejected.
  - `watchlist unique(user_id, symbol)` — duplicate insert rejected at DB level.
  - NOT NULL columns (e.g. portfolio.strike/expiry/premium_received) rejected when omitted.
Expected: schema matches `0001_init.sql`.

## L2 - Dashboard auth  (AUTO)
- T2.1 Unauthenticated visit to `/` redirects to `/login` (middleware).
- T2.2 Login with `ddqphuoc@gmail.com` succeeds and lands on `/` cockpit.
- T2.3 Authenticated visit to `/login` redirects to `/`.
- T2.4 Sign out returns to `/login` and `/` is protected again.
- T2.5 Wrong password / unknown email -> error shown, stays on `/login` (no session).
- T2.6 Session persists across a full page reload (no forced re-login).

## L3 - Dashboard CRUD + RLS write path  (AUTO)
- T3.1 Cash + total_account_value save -> persisted in `profiles` (verify via API) and reflected after reload.
- T3.2 Settings (stagger/poll/stableClose) save -> persisted.
- T3.3 Watchlist add symbol -> row in `watchlist`; renders a card; remove -> row deleted, card gone.
- T3.4 Watchlist duplicate add is rejected/no-dup (unique constraint).
- T3.5 Portfolio add position -> row in `portfolio`; edit -> updated; close -> status='closed'.
- T3.6 Buy/Sell buttons open the IBKR positions URL in a new tab (assert target URL).

## L4 - Realtime & job queues  (AUTO+SEED)
- T4.1 Dashboard "Update data" inserts a `scrape_requests` row (status pending) and shows the status badge.
- T4.2 Update the seeded scrape_request status via API -> dashboard badge updates live (realtime).
- T4.3 "Run Analysis" inserts an `analysis_requests` row with the chosen mode.
- T4.4 Insert an `analyses` row via API for a watchlist symbol -> the symbol card shows verdict/score/why/decision live.
- T4.5 MacroBar: upsert `macro_data` (vix/t10y2y/hy_oas/spy_sma200) via API -> values + timestamps render live.
- T4.6 Cross-client UPDATE behavior: after an external API UPDATE (e.g. scrape_request `pending`->`done`,
  or an `analyses` row edited), the dashboard re-renders the change live WITHOUT a manual reload.
  KNOWN DEFECT: today the dashboard live-pushes INSERTs but not cross-client UPDATEs (needs reload).
  This test is expected to FAIL until the realtime UPDATE handling is wired; keep it as the tracking test.
  NOTE: `watchlist` is NOT in the realtime publication (insert/remove uses local state). Live-update of
  watchlist across tabs is therefore not tested unless we add it to the publication (small change).

## L5 - Derived UI correctness  (AUTO+SEED)
- T5.1 Seed `stocks.<symbol>` jsonb (finviz/optioncharts/yahoo_options/intrinsic) -> watchlist card shows
  price/IV-rank/intrinsic/beta/short%/RSI/earnings and the 5 freshness badges flip from gray to a timestamp.
- T5.2 Seed a `portfolio` row + matching put in `stocks.yahoo_options` -> collateral = strike*100*contracts,
  DTE correct, unrealized P&L = (premium_received - mid)*100*contracts.
- T5.3 Portfolio row with expiry in the past is flagged "expired?".
- T5.4 Missing mid in yahoo_options -> P&L shows "-" (no crash).
- T5.5 Date/timezone rendering: a position with expiry `2026-07-17` renders as Jul 17 (NOT Jul 16) and
  DTE matches the same date. KNOWN DEFECT: currently off-by-one (renders "Jul 16"); expected to FAIL until fixed.
- T5.6 Multi-contract + multiple open positions: P&L scales by contracts and collateral/total aggregate correctly.
- T5.7 Number formatting: market cap (T/B/M), percentages, currency, and negative P&L render correctly.
- T5.8 Empty states: no watchlist / no portfolio / no macro rows -> panels render gracefully (no crash/blank).

## L6 - Prompt builder  (AUTO; runs via `npx tsx scripts/test-prompt.mts`)
- T6.1 `buildPrompt` includes the symbol, mode-specific thresholds, the as-of date, the injected scraped
  blocks, and the trailing JSON-output contract.
- T6.2 Missing scraped block -> renders the "(not available...)" placeholder.
- T6.3 `routine` vs `dip_buy` produce different thresholds/labels in the rendered prompt
  (Routine: annualized >= 12%, IV Rank >= 20, MoS is a GATE; Dip-buy: annualized >= 20%,
  IV Rank >= 30, MoS downgraded to SCORE).
- T6.4 Mode isolation: routine prompt excludes dip-buy-only items (the gap IS the setup,
  "Price fell more than fundamentals", beta * index move); dip_buy prompt includes them.
- T6.5 Reasoning scaffolding is rendered: `Rules of evidence`, `Formulas` (annualized_return,
  margin_of_safety_ok with the `* (1 - 0.15)` form), `Data sufficiency precheck`, and
  `Strike selection` algorithm.
- T6.6 Expanded JSON contract is required: in addition to the legacy keys (`verdict`,
  `score_pass`, `score_total`, `recommended_strike`, `recommended_expiry`, `why`,
  `decision`, `unknowns`), the prompt asks for `data_ok`, `blocking_issues`,
  `gate_results[]`, `score_results[]`, `score_pct`, `recommended_premium_mid`,
  `annualized_return`, and `risk_plan`. `parseVerdict` ignores the extras, so this is
  back-compatible.

## L7 - Parser correctness (public sources)  (NEEDS-CHANGE)
Requires a test runner + fixtures: add `vitest` + `jsdom` to `extension`, plus saved real HTML.
Fixtures are captured automatically by the harness (`page.content()`) for the public sources.
- T7.x For each public parser (finviz, finviz_spy, yahoo_options, yahoo_analysis, yahoo_vix,
  fred_t10y2y, fred_hyoas), feed a captured fixture -> assert the expected ScrapeWrite shape/values;
  assert `null` on an empty/blank document (defensive path).

## L9 - Live scraping per source (public)  (AUTO)
Run via the `harness/` runner, which executes the shared parser against the live DOM and persists.
- T9.1 finviz, T9.2 yahoo options, T9.3 yahoo analysis, T9.4 yahoo VIX, T9.5 FRED t10y2y, T9.6 FRED hy_oas:
  assert each returns non-empty, sane data and writes to `stocks`/`macro_data`.
  Sites may rate-limit/block; treat flakes as INCONCLUSIVE and retry.
- T9.7 Regression guard (sanity bounds so a wrong-element selector can't silently return):
  `5 < VIX < 150`; a symbol's yahoo_options price within ±50% of its finviz price. (Catches the BTC-USD bug.)

## L8 - Pure-logic unit tests  (NEEDS-CHANGE: vitest)
Node-only unit tests (no extension runtime, no browser). Recovers the logic of the out-of-scope
extension/claude/popup layers.
- T8.1 `parseVerdict` (`analysisWorker.ts`): valid JSON, fenced ```json block, malformed/no-JSON,
  missing keys -> defined fallback (no throw).
- T8.2 `formatDiagnostics` (contracts) / `buildDiagnosticsText` (extension): output includes settings,
  per-job data summaries, and errors.
- T8.3 `serializeWrite` + change-detection + `summarizeWrite` (`scrapeCore.ts`): stable string across equal
  writes; unchanged write detected; human-readable summary per source.

## L10 - Harness behavior  (AUTO)
Drives `harness/` directly (public sources only).
- T10.1 Symbol resolution = dedup(watchlist ∪ portfolio), uppercased.
- T10.2 Persist writes the correct `stocks.<column>` + matching `*_updated_at`; macro upserts `macro_data`.
- T10.3 Upsert idempotency: re-running a scrape updates the existing row (no duplicate stocks/macro rows).
- T10.4 Unknown symbol (e.g. `ZZZZ`) -> empty/no crash, no junk row written.
- T10.5 Flags: `--macro-only`, `--no-macro`, and positional symbols select the right job set.

---

## Suggested small changes to widen AUTO coverage
1. Add `vitest` + `jsdom` to `extension` and commit harness-captured HTML fixtures (unlocks L7).
2. Add a `seed`/`cleanup` SQL pair under `supabase/` so L4/L5 seeding is repeatable and reversible.
3. (Optional) Add `watchlist` to the realtime publication to enable T4 cross-tab watchlist live updates.

## Cleanup contract
Every AUTO test that seeds data deletes exactly what it created at the end (by symbol/id), leaving your real
watchlist/portfolio intact. I will report any row I could not clean up.
