// Owner: Agent A (extension engine). Multi-expiration walk for Yahoo Finance
// options. Used by both the orchestrator's full update and the polling manager
// so the persisted yahoo_options column is always the same shape - the chain
// for every expiration within the next 60 days, merged into one write. A
// single-page poll would otherwise overwrite the rich payload with just the
// nearest expiry.
import {
  buildUrl,
  type ScrapeWrite,
  type YahooMarketState,
  type YahooOptionsData,
  type YahooOptionsExpiration,
} from "@optionpilot/contracts";
import { addError } from "./diagnostics";
import { delay, scrapeWithReadiness, type ScrapeResult } from "./scrapeCore";

// 60-day lookahead in Unix seconds.
export const TWO_MONTHS_S = 60 * 24 * 3600;

// Navigate an already-open tab to a new URL and resolve once it finishes
// loading. The listener is attached before the navigation starts so the
// reused tab's stale "complete" status can't short-circuit the wait.
function navigateAndWait(
  tabId: number,
  url: string,
  timeoutMs = 25000,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

interface ApiAttempt {
  attempt: number;
  reason: string;
  status?: number;
}

interface ExpiryDatesResult {
  dates: number[];
  source: "api" | "dom" | "none";
  apiAttempts: ApiAttempt[];
  domSelectorTried?: string;
  domOptionCount?: number;
}

// Inject a function into the Yahoo Finance tab's MAIN world (runs as the page's
// own JS — same cookies, no CORS). Fetches the crumb then calls the Yahoo
// Finance options API to get all available expiration timestamps.
// Retries up to 3 times because the crumb endpoint occasionally returns a
// stale token on the first attempt right after a navigation. Each attempt's
// failure reason is captured so a transient API outage is visible in the
// diagnostics blob instead of silently collapsing the walk to 1 expiration.
async function getExpiryDatesFromApi(
  tabId: number,
  symbol: string,
): Promise<{ dates: number[]; attempts: ApiAttempt[] }> {
  const attempts: ApiAttempt[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await delay(2000);
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (sym: string): Promise<{ dates: number[]; reason?: string; status?: number }> => {
          try {
            const crumbResp = await fetch(
              "https://query2.finance.yahoo.com/v1/test/getcrumb",
              { credentials: "include" },
            );
            if (!crumbResp.ok) return { dates: [], reason: "crumb http error", status: crumbResp.status };
            const crumb = await crumbResp.text();
            if (!crumb) return { dates: [], reason: "crumb empty" };
            if (crumb.trim().startsWith("{")) return { dates: [], reason: "crumb returned JSON (auth/consent)" };
            const apiResp = await fetch(
              `https://query2.finance.yahoo.com/v7/finance/options/${sym}?crumb=${encodeURIComponent(crumb)}`,
              { credentials: "include" },
            );
            if (!apiResp.ok) return { dates: [], reason: "options api http error", status: apiResp.status };
            const json = (await apiResp.json()) as {
              optionChain?: { result?: Array<{ expirationDates?: number[] }> };
            };
            const dates = json.optionChain?.result?.[0]?.expirationDates ?? [];
            if (dates.length === 0) return { dates: [], reason: "options api returned no expirationDates" };
            return { dates };
          } catch (e) {
            return { dates: [], reason: `fetch threw: ${e instanceof Error ? e.message : String(e)}` };
          }
        },
        args: [symbol.toUpperCase()],
      });
      const out = results[0]?.result as { dates?: number[]; reason?: string; status?: number } | undefined;
      const dates = out?.dates ?? [];
      if (dates.length > 0) {
        attempts.push({ attempt, reason: "ok" });
        return { dates, attempts };
      }
      attempts.push({ attempt, reason: out?.reason ?? "unknown", status: out?.status });
    } catch (e) {
      attempts.push({
        attempt,
        reason: `executeScript threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return { dates: [], attempts };
}

// Fallback: read expiration timestamps directly from the loaded Yahoo options
// page DOM. The page's expiry picker is a <select> whose <option> values are
// Unix-second timestamps; recent layouts sometimes use anchor links with
// `?date=<ts>` instead. Try both. Runs in the page's MAIN world.
async function getExpiryDatesFromDom(
  tabId: number,
): Promise<{ dates: number[]; selectorTried: string; optionCount: number }> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (): { dates: number[]; selectorTried: string; optionCount: number } => {
        const selectors: string[] = [];
        const found = new Set<number>();
        // 1) Native <select> with numeric option values.
        const selects = Array.from(document.querySelectorAll<HTMLSelectElement>("select"));
        let optionCount = 0;
        for (const sel of selects) {
          const opts = Array.from(sel.querySelectorAll<HTMLOptionElement>("option"));
          for (const o of opts) {
            const v = o.value?.trim();
            if (!v) continue;
            optionCount += 1;
            const n = Number(v);
            // Yahoo expiry timestamps are Unix seconds (10 digits, ~1e9..2e9).
            if (Number.isFinite(n) && n > 1_000_000_000 && n < 4_000_000_000) {
              found.add(Math.floor(n));
            }
          }
        }
        if (found.size > 0) {
          selectors.push(`select option (${selects.length} selects, ${optionCount} options)`);
          return { dates: [...found].sort((a, b) => a - b), selectorTried: selectors.join("; "), optionCount };
        }
        // 2) Anchor href fallback: `?date=<ts>` query strings.
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="date="]'));
        for (const a of anchors) {
          const m = a.href.match(/[?&]date=(\d+)/);
          if (m) {
            const n = Number(m[1]);
            if (Number.isFinite(n) && n > 1_000_000_000 && n < 4_000_000_000) {
              found.add(Math.floor(n));
            }
          }
        }
        if (found.size > 0) {
          selectors.push(`a[href*="date="] (${anchors.length} anchors)`);
          return { dates: [...found].sort((a, b) => a - b), selectorTried: selectors.join("; "), optionCount };
        }
        return {
          dates: [],
          selectorTried: `select option (${selects.length} selects, ${optionCount} options); a[href*="date="] (${anchors.length} anchors)`,
          optionCount,
        };
      },
    });
    const out = results[0]?.result as
      | { dates?: number[]; selectorTried?: string; optionCount?: number }
      | undefined;
    return {
      dates: out?.dates ?? [],
      selectorTried: out?.selectorTried ?? "",
      optionCount: out?.optionCount ?? 0,
    };
  } catch (e) {
    return {
      dates: [],
      selectorTried: `executeScript threw: ${e instanceof Error ? e.message : String(e)}`,
      optionCount: 0,
    };
  }
}

// Discover every available expiration timestamp for a symbol. Tries the
// crumb-protected API first; on failure falls back to scraping the page's
// expiry <select>. Records what happened so the diagnostics blob explains why
// a walk ended up shorter than expected.
async function getExpiryDates(
  tabId: number,
  symbol: string,
): Promise<ExpiryDatesResult> {
  const { dates: apiDates, attempts } = await getExpiryDatesFromApi(tabId, symbol);
  if (apiDates.length > 0) {
    return { dates: apiDates, source: "api", apiAttempts: attempts };
  }
  const dom = await getExpiryDatesFromDom(tabId);
  if (dom.dates.length > 0) {
    return {
      dates: dom.dates,
      source: "dom",
      apiAttempts: attempts,
      domSelectorTried: dom.selectorTried,
      domOptionCount: dom.optionCount,
    };
  }
  return {
    dates: [],
    source: "none",
    apiAttempts: attempts,
    domSelectorTried: dom.selectorTried,
    domOptionCount: dom.optionCount,
  };
}

export interface YahooOptionsAllDatesResult {
  write: ScrapeWrite | null;
  // Free-form debug payload; surfaces decision inputs for the diagnostics copy
  // blob (per .cursor/rules/diagnostics-first.mdc). Always populated.
  debug: Record<string, unknown>;
  error?: string;
}

// For yahoo_options: scrape every expiration within the next 2 months. Opens
// the default URL, reads the expiry list, then navigates the same tab to each
// ?date=<ts> URL and accumulates the puts. Returns a single combined write
// plus a debug payload describing exactly what was discovered and walked.
export async function scrapeYahooOptionsAllDates(
  tabId: number,
  symbol: string,
): Promise<YahooOptionsAllDatesResult> {
  const nowS = Date.now() / 1000;
  const cutoffS = nowS + TWO_MONTHS_S;

  // Scrape the default page first — this also ensures the content script is
  // fully injected (scrapeWithReadiness retries until it connects). Only then
  // fetch the expiry date list; a parallel attempt races the content script
  // injection and silently returns [] when the connection isn't ready yet.
  const firstResult = await scrapeWithReadiness(tabId, "yahoo_options", symbol);
  const expiryDiscovery = await getExpiryDates(tabId, symbol);
  const { dates: allDates, source: discoverySource, apiAttempts } = expiryDiscovery;

  // Surface a hard failure on the discovery step. The walk will degrade to
  // just the first page (1 expiration) - record an error so the copy blob
  // explains why the dataSummary will say "1 expirations" instead of ~11.
  if (discoverySource === "none") {
    const reasons = apiAttempts.map((a) => `#${a.attempt}: ${a.reason}${a.status ? ` (status ${a.status})` : ""}`).join("; ");
    addError(
      `${symbol.toUpperCase()} yahoo_options.getExpiryDates`,
      `crumb API failed and DOM fallback found no dates - falling back to nearest expiry only. attempts=[${reasons}]; dom=${expiryDiscovery.domSelectorTried ?? ""}`,
    );
  }

  // Seed with whatever the first page gave us (price + first expiration).
  let price: number | null = null;
  let marketState: YahooMarketState = "UNKNOWN";
  const expirations: YahooOptionsExpiration[] = [];

  // The first non-UNKNOWN marketState wins, EXCEPT a later non-REGULAR state
  // overrides an earlier REGULAR one (we want the most pessimistic across the
  // walk so a snapshot that straddled a session boundary still triggers the
  // closed-market warning).
  const recordState = (next: YahooMarketState | undefined) => {
    if (!next || next === "UNKNOWN") return;
    if (marketState === "UNKNOWN" || marketState === "REGULAR") {
      marketState = next;
    }
  };

  const mergeWrite = (write: ScrapeWrite | null) => {
    if (!write || write.kind !== "stock_json") return;
    const d = write.data as unknown as YahooOptionsData;
    if (d.price != null) price = d.price;
    recordState(d.marketState);
    for (const exp of d.expirations ?? []) expirations.push(exp);
  };
  mergeWrite(firstResult.write);

  // Filter to future expirations within 2 months, skipping any already scraped.
  const scrapedDates = new Set(expirations.map((e) => e.expiry));
  const remaining = allDates.filter((ts) => ts > nowS && ts <= cutoffS);
  const walkedDates: number[] = [];
  const walkErrors: string[] = [];

  for (const ts of remaining) {
    const url = `https://ca.finance.yahoo.com/quote/${symbol.toUpperCase()}/options/?date=${ts}`;
    await navigateAndWait(tabId, url);
    const result = await scrapeWithReadiness(tabId, "yahoo_options", symbol);
    walkedDates.push(ts);
    if (result.error) walkErrors.push(`${ts}: ${result.error}`);
    if (result.write) {
      const d = result.write.kind === "stock_json"
        ? (result.write.data as unknown as YahooOptionsData)
        : null;
      recordState(d?.marketState);
      for (const exp of d?.expirations ?? []) {
        if (!scrapedDates.has(exp.expiry)) {
          expirations.push(exp);
          scrapedDates.add(exp.expiry);
        }
      }
    }
  }

  // Compute the DTE distribution of the persisted chain so the diagnostics
  // blob explains analyses that fail precheck A. The CSP entry GATE is 30-45
  // DTE; we widen the sanity check to 30-60 to also catch the 21-DTE roll
  // window. If nothing landed in 30-60 DTE we surface that as an explicit
  // error rather than letting the analysis silently FAIL precheck A.
  const todayMs = Date.now();
  const dteList = expirations
    .map((e) => {
      const t = Date.parse(`${e.expiry}T00:00:00Z`);
      return Number.isFinite(t) ? Math.round((t - todayMs) / 86_400_000) : null;
    })
    .filter((d): d is number => d != null);
  const hasMidWindow = dteList.some((d) => d >= 30 && d <= 60);
  if (!hasMidWindow && expirations.length > 0) {
    const maxDte = dteList.length > 0 ? Math.max(...dteList) : -1;
    addError(
      `${symbol.toUpperCase()} yahoo_options.walk`,
      `walked ${expirations.length} expirations but none in 30-60 DTE; latest DTE=${maxDte} (likely Yahoo returned only short-dated weeklies)`,
    );
  }

  const debug: Record<string, unknown> = {
    optionsWalk: "full",
    allDatesCount: allDates.length,
    discoverySource,
    apiAttempts,
    cutoffISO: new Date(cutoffS * 1000).toISOString(),
    walkedDates,
    scrapedExpiries: [...scrapedDates],
    walkErrors,
    dteList,
    hasMidWindow,
    marketState,
  };
  if (expiryDiscovery.domSelectorTried) debug.domSelectorTried = expiryDiscovery.domSelectorTried;
  if (expiryDiscovery.domOptionCount != null) debug.domOptionCount = expiryDiscovery.domOptionCount;
  if (firstResult.error) debug.firstPageError = firstResult.error;

  // Navigate back to the default URL so the tab is left in a clean state.
  // Polling re-runs this same walk, so the page state isn't load-bearing for
  // correctness anymore - but a clean default URL is still the friendliest
  // thing to show the user if they peek at the scrape window.
  if (remaining.length > 0) {
    await navigateAndWait(tabId, buildUrl("yahoo_options", symbol));
  }

  if (price == null && expirations.length === 0) {
    return {
      write: null,
      debug,
      error: firstResult.error ?? "no price and no expirations parsed",
    };
  }

  const merged: YahooOptionsData = { price, expirations, marketState };
  return {
    write: {
      kind: "stock_json",
      symbol: symbol.toUpperCase(),
      column: "yahoo_options",
      data: merged as unknown as Record<string, unknown>,
    },
    debug,
  };
}

// Adapter for callers that expect the standard ScrapeResult shape (the polling
// manager's pollOnce). Keeps pollOnce's persist + change-detection + stable-
// close logic identical for yahoo_options vs every other source.
export async function scrapeYahooOptionsAllDatesAsResult(
  tabId: number,
  symbol: string,
): Promise<ScrapeResult> {
  const r = await scrapeYahooOptionsAllDates(tabId, symbol);
  return { write: r.write, error: r.error, debug: r.debug };
}
