// Owner: Agent A (extension engine). Drives an "update": builds jobs from the
// user's watchlist + portfolio (per-symbol) plus shared macro (once), opens one
// window per symbol staggered by the configured delay, scrapes each tab, and
// registers tabs with the polling manager. Triggered by the popup (START_UPDATE)
// or by a scrape_requests row inserted from the dashboard (via Realtime).
import {
  MACRO_SOURCES,
  PER_SYMBOL_SOURCES,
  buildUrl,
  sourceForUrl,
  type PopupToBackground,
  type ScrapeProgress,
  type SourceId,
} from "@optionpilot/contracts";
import { getSupabase } from "../supabase/client";
import {
  delay,
  getSettings,
  getUserSymbols,
  persistWrite,
  scrapeWithReadiness,
  serializeWrite,
  summarizeWrite,
} from "./scrapeCore";
import { scrapeYahooOptionsAllDates } from "./yahooOptionsAllDates";
import { registerTab, startPolling, trackedCount } from "./pollingManager";
import { openClaudeTab } from "./claudeTab";
import {
  addError,
  getDiagnostics,
  noteScrapeRequestReceived,
  noteScrapeRequestsChecked,
  resetDiagnostics,
  seedJob,
  setCountdown,
  setRunning,
  setScrapeRequestsWatching,
  updateJob,
} from "./diagnostics";

interface Job {
  source: SourceId;
  symbol?: string;
  url: string;
}

let running = false;
let scrapeWindowId: number | undefined;
let progress: ScrapeProgress = {
  running: false,
  total: 0,
  completed: 0,
  openTabs: 0,
};

function pushProgress(): void {
  progress = { ...progress, openTabs: trackedCount() };
  try {
    void chrome.runtime.sendMessage({ type: "PROGRESS", progress });
  } catch {
    // no popup listening
  }
}

function waitForComplete(tabId: number, timeoutMs = 25000): Promise<void> {
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
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") finish();
    });
    setTimeout(finish, timeoutMs);
  });
}

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

// Pull an already-open tab whose site matches this job out of the candidate
// pool, so we scrape it in place instead of spawning a new tab. Each tab is
// claimed at most once per run. Only tabs that were open before the run began
// are candidates — we never reuse tabs this run created (they are mid-scrape /
// being polled).
function claimReusableTab(
  job: Job,
  pool: chrome.tabs.Tab[],
): chrome.tabs.Tab | undefined {
  const idx = pool.findIndex(
    (t) => t.id != null && t.url != null && sourceForUrl(t.url) === job.source,
  );
  if (idx === -1) return undefined;
  const [tab] = pool.splice(idx, 1);
  return tab;
}

async function scrapeAndPersist(
  tabId: number,
  source: SourceId,
  symbol: string | undefined,
): Promise<void> {
  // yahoo_options: scrape all expirations within the next 2 months by
  // navigating through each available date URL on the same tab. The walk
  // returns its own debug payload (allDatesCount, walkedDates, discovery
  // source, etc.) so a copied diagnostics blob explains a short walk.
  if (source === "yahoo_options" && symbol) {
    const { write, debug, error } = await scrapeYahooOptionsAllDates(tabId, symbol);
    if (write) {
      try {
        await persistWrite(write);
        updateJob(source, symbol, {
          status: "scraped",
          dataSummary: summarizeWrite(write, debug),
          data: write.kind === "stock_json" ? write.data : write,
          debug,
          message: undefined,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        updateJob(source, symbol, { status: "error", message: `persist failed: ${msg}`, debug });
        addError(`${symbol} ${source}`, `persist failed: ${msg}`);
      }
    } else if (error) {
      updateJob(source, symbol, { status: "error", message: error, debug });
      addError(`${symbol} ${source}`, error);
    } else {
      updateJob(source, symbol, {
        status: "empty",
        message: "Parser ran but found no data (likely a selector miss).",
        debug,
      });
    }
    registerTab(tabId, source, symbol, serializeWrite(write));
    progress = { ...progress, completed: progress.completed + 1 };
    pushProgress();
    return;
  }

  const { write, error, debug } = await scrapeWithReadiness(tabId, source, symbol);
  if (write) {
    try {
      await persistWrite(write);
      updateJob(source, symbol, {
        status: "scraped",
        dataSummary: summarizeWrite(write),
        data: write.kind === "stock_json" ? write.data : write,
        debug,
        message: undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateJob(source, symbol, { status: "error", message: `persist failed: ${msg}`, debug });
      addError(`${symbol ?? "macro"} ${source}`, `persist failed: ${msg}`);
    }
  } else if (error) {
    updateJob(source, symbol, { status: "error", message: error, debug });
    addError(`${symbol ?? "macro"} ${source}`, error);
  } else {
    updateJob(source, symbol, {
      status: "empty",
      message: "Parser ran but found no data (likely a selector miss).",
      debug,
    });
  }
  registerTab(tabId, source, symbol, serializeWrite(write));
  progress = { ...progress, completed: progress.completed + 1 };
  pushProgress();
}

interface PlannedJob {
  job: Job;
  tabId?: number;
  reused: boolean;
  reusedUrl?: string;
}

async function openWindowAndScrape(
  jobs: Job[],
  pool: chrome.tabs.Tab[],
): Promise<void> {
  if (jobs.length === 0) return;

  // Resolve each job to a tab: reuse a matching open tab when one exists,
  // otherwise mark it for a freshly created tab.
  const plan: PlannedJob[] = jobs.map((job) => {
    const reused = claimReusableTab(job, pool);
    return {
      job,
      tabId: reused?.id,
      reused: reused != null,
      reusedUrl: reused?.url,
    };
  });

  // Open / reuse a single background window for all new tabs across the whole
  // run. The first batch creates the window; subsequent batches add tabs to it.
  const fresh = plan.filter((p) => p.tabId == null);
  if (fresh.length > 0) {
    if (scrapeWindowId == null) {
      const win = await chrome.windows.create({
        url: fresh.map((p) => p.job.url),
        focused: false,
      });
      scrapeWindowId = win.id;
      const tabs = win.tabs ?? [];
      fresh.forEach((p, i) => {
        p.tabId = tabs[i]?.id;
      });
    } else {
      await Promise.all(
        fresh.map(async (p) => {
          const tab = await chrome.tabs.create({
            windowId: scrapeWindowId,
            url: p.job.url,
            active: false,
          });
          p.tabId = tab.id;
        }),
      );
    }
  }

  await Promise.all(
    plan.map(async (p) => {
      const { job } = p;
      if (p.tabId == null) {
        updateJob(job.source, job.symbol, { status: "error", message: "Tab failed to open" });
        addError(`${job.symbol ?? "macro"} ${job.source}`, "Tab failed to open");
        return;
      }
      progress = { ...progress, current: `${job.symbol ?? "macro"} ${job.source}` };
      updateJob(job.source, job.symbol, { status: "opening" });
      if (p.reused && p.reusedUrl !== job.url) {
        // Reused tab is on a different page (e.g. another symbol): repoint it.
        await navigateAndWait(p.tabId, job.url);
      } else {
        // Fresh tab, or a reused tab already on the target URL (no reload).
        await waitForComplete(p.tabId);
      }
      updateJob(job.source, job.symbol, { status: "loading" });
      await scrapeAndPersist(p.tabId, job.source, job.symbol);
    }),
  );
}

export async function runUpdate(): Promise<void> {
  if (running) return;

  running = true;
  scrapeWindowId = undefined;
  const settings = await getSettings();
  await startPolling();

  const symbols = await getUserSymbols();
  const macroJobs: Job[] = MACRO_SOURCES.map((source) => ({
    source,
    url: buildUrl(source),
  }));
  const perSymbolWindows: Job[][] = symbols.map((symbol) =>
    PER_SYMBOL_SOURCES.map((source) => ({ source, symbol, url: buildUrl(source, symbol) })),
  );

  progress = {
    running: true,
    total: macroJobs.length + symbols.length * PER_SYMBOL_SOURCES.length,
    completed: 0,
    openTabs: 0,
  };
  pushProgress();

  // Seed diagnostics for this run (every job listed up front as "pending").
  resetDiagnostics({
    running: true,
    settings: {
      staggerDelayMs: settings.staggerDelayMs,
      pollIntervalMs: settings.pollIntervalMs,
      stableCloseCount: settings.stableCloseCount,
    },
  });
  for (const job of macroJobs) seedJob(job.source, job.symbol, job.url);
  for (const win of perSymbolWindows) for (const job of win) seedJob(job.source, job.symbol, job.url);
  setRunning(true);

  // Snapshot the tabs that are already open so we reuse them instead of opening
  // duplicates. Captured once up front so tabs created during this run are not
  // themselves treated as reusable.
  const reusePool = await chrome.tabs.query({});

  try {
    // Shared macro opens once, first.
    await openWindowAndScrape(macroJobs, reusePool);
    // Now that the scrape window exists, open the persistent claude.ai tab
    // inside it (fire-and-forget) so the tab warms up while we scrape the
    // per-symbol windows, and so it lives alongside the other scrape tabs
    // instead of being dropped into the user's focused window.
    if (scrapeWindowId != null) void openClaudeTab(scrapeWindowId);
    // Then one window per symbol, staggered. Surface a live countdown to the
    // next window during each stagger wait so the monitor shows what's coming.
    for (let i = 0; i < perSymbolWindows.length; i++) {
      if (!running) break;
      await openWindowAndScrape(perSymbolWindows[i], reusePool);
      if (i < perSymbolWindows.length - 1) {
        const nextSymbol = perSymbolWindows[i + 1][0]?.symbol;
        const nextWindowAt = new Date(Date.now() + settings.staggerDelayMs).toISOString();
        setCountdown(nextWindowAt, nextSymbol);
        await delay(settings.staggerDelayMs);
        setCountdown(undefined);
      }
    }
  } finally {
    running = false;
    scrapeWindowId = undefined;
    progress = { ...progress, running: false };
    pushProgress();
    setCountdown(undefined);
    setRunning(false);
  }
}

// Seed the diagnostics panel with every job we WOULD scrape (all watchlist +
// portfolio symbols x sources, plus macro), shown as "pending" - without opening
// any windows. Used so the popup shows the plan before a run. No-op while running
// or when a previous run's results are already present.
export async function previewPlan(): Promise<void> {
  if (running) return;
  if (getDiagnostics().jobs.length > 0) return;

  const settings = await getSettings();
  // Reset first so any error surfaced by getUserSymbols (below) survives into
  // the diagnostics copy instead of being cleared by the reset.
  resetDiagnostics({
    running: false,
    settings: {
      staggerDelayMs: settings.staggerDelayMs,
      pollIntervalMs: settings.pollIntervalMs,
      stableCloseCount: settings.stableCloseCount,
    },
  });
  const symbols = await getUserSymbols();
  for (const source of MACRO_SOURCES) seedJob(source, undefined, buildUrl(source));
  for (const symbol of symbols)
    for (const source of PER_SYMBOL_SOURCES) seedJob(source, symbol, buildUrl(source, symbol));
}

async function processPendingScrapeRequests(): Promise<void> {
  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("scrape_requests")
      .select("id")
      .eq("status", "pending");
    noteScrapeRequestsChecked();
    const pending = data?.length ?? 0;
    console.info(`[scrape_requests] recovery sweep: ${pending} pending`);
    if (data && data.length > 0) await handleScrapeRequest(data[0].id);
  } catch {
    // ignore (likely not signed in yet)
  }
}

async function handleScrapeRequest(id: string): Promise<void> {
  const sb = getSupabase();
  await sb.from("scrape_requests").update({ status: "running" }).eq("id", id);
  try {
    await runUpdate();
    await sb
      .from("scrape_requests")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", id);
  } catch (e) {
    await sb
      .from("scrape_requests")
      .update({ status: "error", error: e instanceof Error ? e.message : String(e) })
      .eq("id", id);
  }
}

function subscribeScrapeRequests(): void {
  try {
    const sb = getSupabase();
    sb.channel("optionpilot-scrape-requests")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "scrape_requests" },
        (payload) => {
          const row = payload.new as { id: string; status: string };
          if (row.status === "pending") {
            noteScrapeRequestReceived(row.id);
            console.info(`[scrape_requests] new pending request received: ${row.id}`);
            void handleScrapeRequest(row.id);
          }
        },
      )
      .subscribe((status) => {
        setScrapeRequestsWatching(status);
        console.info(`[scrape_requests] realtime subscription: ${status}`);
      });
  } catch {
    // ignore subscription errors
  }
}

export function startEngine(): void {
  chrome.runtime.onMessage.addListener(
    (msg: PopupToBackground, _sender, sendResponse) => {
      switch (msg.type) {
        case "START_UPDATE":
          void runUpdate();
          sendResponse({ ok: true });
          return true;
        case "STOP_UPDATE":
          running = false;
          sendResponse({ ok: true });
          return true;
        case "GET_PROGRESS":
          sendResponse(progress);
          return true;
        case "GET_DIAGNOSTICS":
          sendResponse(getDiagnostics());
          return true;
        case "PREVIEW_PLAN":
          void previewPlan().then(() => sendResponse(getDiagnostics()));
          return true;
        default:
          return false;
      }
    },
  );

  subscribeScrapeRequests();
  void processPendingScrapeRequests();
}
