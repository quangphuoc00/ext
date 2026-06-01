// Extension-less scraper harness.
//
// Drives the SAME parser contracts the Chrome extension uses, but headlessly via
// Playwright + jsdom, and writes to Supabase directly. This lets the whole scrape
// pipeline run unattended from a command, with no extension UI interaction.
//
// Only PUBLIC (no-login) sources are wired here: finviz, yahoo (options/analysis/
// vix), and FRED. Login-gated sources (optioncharts, stockoracle) are intentionally
// skipped until a logged-in browser profile is configured.
//
// Usage:
//   npm run scrape                 # macro + all watchlist/portfolio symbols
//   npm run scrape -- AAPL TSLA    # macro + just these symbols
//   npm run scrape -- --macro-only # macro metrics only
//   npm run scrape -- --no-macro AAPL
//   HEADLESS=false npm run scrape -- AAPL   # watch the browser

import dotenv from "dotenv";
import { chromium, type BrowserContext, type Page } from "playwright";
import { JSDOM } from "jsdom";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildUrl, type ScrapeWrite, type SourceId } from "@optionpilot/contracts";
import { getParser } from "../extension/src/content/registry";
import { buildPersistOp, dedupeSymbols, planJobs } from "./lib.mts";

dotenv.config({ path: ".env.local" });
dotenv.config();

// ---- Config ----------------------------------------------------------------

const SUPABASE_URL = need("SUPABASE_URL");
const SUPABASE_KEY = need("SUPABASE_KEY");
const EMAIL = need("OPTIONPILOT_EMAIL");
const PASSWORD = need("OPTIONPILOT_PASSWORD");
const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";

// Per-source "page is ready" hint selectors (best-effort; failure is non-fatal).
const READY: Partial<Record<SourceId, string>> = {
  finviz: "table.snapshot-table2",
  finviz_spy: "table.snapshot-table2",
  yahoo_options: "table",
  yahoo_analysis: "table",
  yahoo_vix: "fin-streamer",
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---- Types -----------------------------------------------------------------

interface JobResult {
  source: SourceId;
  symbol?: string;
  status: "ok" | "empty" | "error";
  summary: string;
  ms: number;
}

// ---- Helpers ---------------------------------------------------------------

function need(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing required env var ${key} (set it in harness/.env.local)`);
    process.exit(1);
  }
  return v;
}

function summarize(write: ScrapeWrite): string {
  if (write.kind === "macro") {
    return `${write.metric} = ${write.value}${write.asOf ? ` (as of ${write.asOf})` : ""}`;
  }
  if (write.kind === "stock_intrinsic") return `intrinsic = ${write.value}`;
  const data = write.data as Record<string, unknown>;
  switch (write.column) {
    case "yahoo_options": {
      const exps = Array.isArray(data.expirations)
        ? (data.expirations as { puts?: unknown[] }[])
        : [];
      const records = exps.reduce((n, e) => n + (Array.isArray(e.puts) ? e.puts.length : 0), 0);
      return `price=${String(data.price ?? "?")}, ${exps.length} expirations, ${records} puts`;
    }
    case "yahoo_analysis": {
      const eps = Array.isArray(data.epsEstimate) ? data.epsEstimate.length : 0;
      const rev = Array.isArray(data.revenueEstimate) ? data.revenueEstimate.length : 0;
      return `${eps} EPS, ${rev} revenue periods`;
    }
    case "finviz":
      return `price=${String(data.price ?? "?")}, beta=${String(data.beta ?? "?")}, rsi=${String(data.rsi14 ?? "?")}`;
    default:
      return "scraped";
  }
}

async function handleYahooConsent(page: Page): Promise<void> {
  if (!/consent|guce/i.test(page.url())) return;
  const btn = page
    .locator('button[name="agree"], button:has-text("Accept all"), button:has-text("Agree")')
    .first();
  await btn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
}

async function persist(sb: SupabaseClient, write: ScrapeWrite): Promise<void> {
  const op = buildPersistOp(write, new Date().toISOString());
  const { error } = await sb.from(op.table).upsert(op.row, { onConflict: op.onConflict });
  if (error) throw new Error(error.message);
}

async function scrapeOne(
  context: BrowserContext,
  sb: SupabaseClient,
  source: SourceId,
  symbol?: string,
): Promise<JobResult> {
  const started = Date.now();
  const url = buildUrl(source, symbol);
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await handleYahooConsent(page);

    const ready = READY[source];
    if (ready) await page.waitForSelector(ready, { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);

    const html = await page.content();
    const dom = new JSDOM(html, { url: page.url() });
    // Parsers reference the global `Node` (e.g. compareDocumentPosition flags).
    (globalThis as unknown as { Node: unknown }).Node = dom.window.Node;
    const doc = dom.window.document as unknown as Document;

    const write = getParser(source)(doc, { symbol });
    if (!write) {
      return { source, symbol, status: "empty", summary: "parser returned null", ms: Date.now() - started };
    }
    await persist(sb, write);
    return { source, symbol, status: "ok", summary: summarize(write), ms: Date.now() - started };
  } catch (e) {
    return {
      source,
      symbol,
      status: "error",
      summary: e instanceof Error ? e.message : String(e),
      ms: Date.now() - started,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function resolveSymbols(sb: SupabaseClient): Promise<string[]> {
  const [{ data: wl }, { data: pf }] = await Promise.all([
    sb.from("watchlist").select("symbol"),
    sb.from("portfolio").select("symbol"),
  ]);
  return dedupeSymbols([...(wl ?? []), ...(pf ?? [])].map((r) => r.symbol as string | null));
}

// ---- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const symbolArgs = args.filter((a) => !a.startsWith("--")).map((s) => s.toUpperCase());
  const doMacro = !flags.has("--no-macro");
  const macroOnly = flags.has("--macro-only");

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { error: authErr } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (authErr) {
    console.error(`Auth failed: ${authErr.message}`);
    process.exit(1);
  }
  console.log(`Signed in as ${EMAIL}`);

  const symbols = macroOnly ? [] : symbolArgs.length ? symbolArgs : await resolveSymbols(sb);
  if (!macroOnly) console.log(`Symbols: ${symbols.length ? symbols.join(", ") : "(none)"}`);

  const jobs = planJobs({ symbols, macro: doMacro, macroOnly });

  console.log(`Launching Chromium (headless=${HEADLESS}); ${jobs.length} jobs\n`);
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });

  const results: JobResult[] = [];
  for (const job of jobs) {
    const label = `${job.source}${job.symbol ? `:${job.symbol}` : ""}`;
    process.stdout.write(`  ${label} ... `);
    const r = await scrapeOne(context, sb, job.source, job.symbol);
    results.push(r);
    console.log(`${r.status.toUpperCase()} (${r.ms}ms) ${r.summary}`);
  }

  await context.close();
  await browser.close();
  await sb.auth.signOut();

  const ok = results.filter((r) => r.status === "ok").length;
  const empty = results.filter((r) => r.status === "empty").length;
  const err = results.filter((r) => r.status === "error").length;
  console.log(`\nDone: ${ok} ok, ${empty} empty, ${err} error (of ${results.length}).`);
  if (err > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
