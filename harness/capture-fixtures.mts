// Capture real HTML for each public source into extension/test/fixtures/*.html
// so the vitest parser suite (L7) can run deterministically/offline.
// Usage: npx tsx capture-fixtures.mts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { buildUrl, type SourceId } from "@optionpilot/contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../extension/test/fixtures");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const READY: Partial<Record<SourceId, string>> = {
  finviz: "table.snapshot-table2",
  finviz_spy: "table.snapshot-table2",
  yahoo_options: "table",
  yahoo_analysis: "table",
  yahoo_vix: "fin-streamer",
  // optioncharts is an SPA: the chain (table OR ARIA grid) only mounts after
  // hydration. Wait for either layout before snapshotting.
  optioncharts: "table tbody tr, [role='row']",
};

// source -> (symbol, fixture filename)
const JOBS: { source: SourceId; symbol?: string; file: string }[] = [
  { source: "finviz", symbol: "AAPL", file: "finviz.html" },
  { source: "finviz_spy", file: "finviz_spy.html" },
  { source: "yahoo_options", symbol: "AAPL", file: "yahoo_options.html" },
  { source: "yahoo_analysis", symbol: "AAPL", file: "yahoo_analysis.html" },
  { source: "yahoo_vix", file: "yahoo_vix.html" },
  { source: "fred_t10y2y", file: "fred_t10y2y.html" },
  { source: "fred_hyoas", file: "fred_hyoas.html" },
  { source: "optioncharts", symbol: "AAPL", file: "optioncharts.html" },
];

async function consent(page: Page): Promise<void> {
  if (!/consent|guce/i.test(page.url())) return;
  await page
    .locator('button[name="agree"], button:has-text("Accept all"), button:has-text("Agree")')
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US" });

for (const job of JOBS) {
  const url = buildUrl(job.source, job.symbol);
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await consent(page);
    const ready = READY[job.source];
    if (ready) await page.waitForSelector(ready, { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    const html = await page.content();
    await writeFile(resolve(OUT, job.file), html, "utf8");
    console.log(`saved ${job.file} (${(html.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    console.error(`FAILED ${job.file}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await page.close().catch(() => {});
  }
}

await browser.close();
console.log("done");
