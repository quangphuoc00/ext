// Owner: Agent A (extension engine). chrome.alarms loop: re-scrape each open
// tab on an interval, track unchanged counts, and auto-close a tab after
// `stableCloseCount` consecutive unchanged reads.
import type { SourceId } from "@optionpilot/contracts";
import {
  ensureContentScript,
  getSettings,
  persistWrite,
  scrapeTab,
  serializeWrite,
  summarizeWrite,
  type ScrapeSettings,
} from "./scrapeCore";
import { scrapeYahooOptionsAllDatesAsResult } from "./yahooOptionsAllDates";
import { updateJob } from "./diagnostics";

interface TrackedTab {
  tabId: number;
  source: SourceId;
  symbol?: string;
  lastSerialized: string;
  unchanged: number;
  scrapeCount: number;
}

const ALARM = "optionpilot-poll";
const tracked = new Map<number, TrackedTab>();
// Per-tab re-entry guard. The yahoo_options full walk navigates the tab
// through every expiration, which can take longer than `pollIntervalMs`
// (default 60s); chrome.alarms fires regardless. Without this guard the next
// alarm would start a second walk on the same tab, racing the first.
const inFlight = new Set<number>();
let settings: ScrapeSettings | null = null;

export function registerTab(
  tabId: number,
  source: SourceId,
  symbol: string | undefined,
  initialSerialized: string,
): void {
  tracked.set(tabId, {
    tabId,
    source,
    symbol,
    lastSerialized: initialSerialized,
    unchanged: 0,
    scrapeCount: initialSerialized ? 1 : 0,
  });
}

export function unregisterTab(tabId: number): void {
  tracked.delete(tabId);
  inFlight.delete(tabId);
}

export async function startPolling(): Promise<void> {
  settings = await getSettings();
  const periodInMinutes = Math.max(0.5, settings.pollIntervalMs / 60000);
  chrome.alarms.create(ALARM, { periodInMinutes });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tracked.delete(tabId);
  inFlight.delete(tabId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  void pollOnce();
});

async function pollOnce(): Promise<void> {
  if (!settings) settings = await getSettings();
  const stableCloseCount = settings.stableCloseCount;

  for (const entry of [...tracked.values()]) {
    // Skip tabs whose previous poll is still running. Without this, an in-
    // progress yahoo_options full walk would be raced by the next alarm.
    if (inFlight.has(entry.tabId)) {
      updateJob(entry.source, entry.symbol, {
        message: "skipped: previous poll still in flight",
      });
      continue;
    }
    inFlight.add(entry.tabId);
    try {
      // yahoo_options polls re-run the same multi-expiration walk used by the
      // full update so the persisted column always carries every expiration
      // within 60 days. A single-page poll would overwrite the rich payload
      // with just the nearest expiry.
      let { write, error, debug } =
        entry.source === "yahoo_options" && entry.symbol
          ? await scrapeYahooOptionsAllDatesAsResult(entry.tabId, entry.symbol)
          : await scrapeTab(entry.tabId, entry.source, entry.symbol);
      // A tracked tab can lose its content script between polls (SPA re-render /
      // auth bounce). Re-inject once and retry before recording a connection error.
      if (error && /could not establish connection|receiving end does not exist/i.test(error)) {
        await ensureContentScript(entry.tabId);
        ({ write, error, debug } =
          entry.source === "yahoo_options" && entry.symbol
            ? await scrapeYahooOptionsAllDatesAsResult(entry.tabId, entry.symbol)
            : await scrapeTab(entry.tabId, entry.source, entry.symbol));
      }
      entry.scrapeCount += 1;
      if (write) {
        await persistWrite(write);
        updateJob(entry.source, entry.symbol, {
          status: "scraped",
          dataSummary: summarizeWrite(write, debug),
          data: write.kind === "stock_json" ? write.data : write,
          debug,
          scrapeCount: entry.scrapeCount,
          message: undefined,
        });
      } else if (error) {
        updateJob(entry.source, entry.symbol, { status: "error", message: error, debug, scrapeCount: entry.scrapeCount });
      } else {
        updateJob(entry.source, entry.symbol, { status: "empty", debug, scrapeCount: entry.scrapeCount });
      }
      const serialized = serializeWrite(write);

      if (serialized && serialized === entry.lastSerialized) {
        entry.unchanged += 1;
      } else {
        entry.unchanged = serialized ? 0 : entry.unchanged + 1;
        if (serialized) entry.lastSerialized = serialized;
      }

      if (entry.unchanged >= stableCloseCount) {
        tracked.delete(entry.tabId);
        try {
          await chrome.tabs.remove(entry.tabId);
        } catch {
          // tab already gone
        }
      }
    } finally {
      inFlight.delete(entry.tabId);
    }
  }
}

export function trackedCount(): number {
  return tracked.size;
}
