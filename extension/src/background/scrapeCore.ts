// Owner: Agent A (extension engine). Shared scrape helpers used by the
// orchestrator and the polling manager: send a SCRAPE message to a tab, persist
// the resulting write to Supabase, and read per-user config + symbols.
import type {
  ContentToBackground,
  Json,
  ScrapeWrite,
  SourceId,
} from "@optionpilot/contracts";
import { getSupabase } from "../supabase/client";
import { addError } from "./diagnostics";

export interface ScrapeSettings {
  staggerDelayMs: number;
  pollIntervalMs: number;
  stableCloseCount: number;
}

const DEFAULT_SETTINGS: ScrapeSettings = {
  staggerDelayMs: 15000,
  pollIntervalMs: 60000,
  stableCloseCount: 10,
};

export async function getSettings(): Promise<ScrapeSettings> {
  try {
    const sb = getSupabase();
    // Admin build reads across all users (service role), so there may be many
    // profile rows; the scrape-timing settings are global, so just take one.
    const { data } = await sb
      .from("profiles")
      .select("stagger_delay_ms, poll_interval_ms, stable_close_count")
      .limit(1)
      .maybeSingle();
    if (!data) return DEFAULT_SETTINGS;
    return {
      staggerDelayMs: data.stagger_delay_ms ?? DEFAULT_SETTINGS.staggerDelayMs,
      pollIntervalMs: data.poll_interval_ms ?? DEFAULT_SETTINGS.pollIntervalMs,
      stableCloseCount:
        data.stable_close_count ?? DEFAULT_SETTINGS.stableCloseCount,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Distinct uppercased symbols across EVERY user's watchlist + portfolio.
// The extension runs with the public anon key (no sign-in), so it cannot read
// those owner-scoped tables directly; instead it calls the all_tracked_symbols()
// SECURITY DEFINER function (migration 0002), which returns only the symbol set.
export async function getUserSymbols(): Promise<string[]> {
  const sb = getSupabase();
  const { data, error } = await sb.rpc("all_tracked_symbols");
  // Surface (don't swallow) failures so the cause shows up in the diagnostics
  // copy instead of silently yielding zero symbols.
  if (error) addError("getUserSymbols", `all_tracked_symbols failed: ${error.message}`);
  const set = new Set<string>();
  for (const r of data ?? []) if (r.symbol) set.add(r.symbol.toUpperCase());
  return [...set];
}

export interface ScrapeResult {
  write: ScrapeWrite | null;
  error?: string;
  debug?: Record<string, unknown> | null;
}

// Force-inject the data-source content script into a tab. The declarative
// content_scripts entry runs at document_idle, but heavy / client-rendered
// pages (and pages that hard-redirect or re-render after load, e.g. an auth
// bounce) can leave a tab with no SCRAPE listener - surfacing as "Could not
// establish connection. Receiving end does not exist." Re-injecting on demand
// re-registers the listener so scraping never depends on the declarative
// injection winning the load race. Requires the "scripting" permission and host
// access to the tab's current URL (granted via host_permissions).
function dataContentScriptFiles(): string[] {
  // The data-source content script is the first content_scripts entry (see
  // manifest.config.ts); it bundles every parser plus the SCRAPE listener.
  // Read it from the live manifest so the hashed build filename isn't hardcoded.
  return chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
}

export async function ensureContentScript(tabId: number): Promise<void> {
  const files = dataContentScriptFiles();
  if (files.length === 0) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch {
    // Tab closed, or the current URL is outside our host_permissions (e.g. a
    // consent/login redirect we can't access). Let the original connection
    // error surface to the caller.
  }
}

// Send a SCRAPE message into a tab and return the write (or an error reason).
export async function scrapeTab(
  tabId: number,
  source: SourceId,
  symbol?: string,
): Promise<ScrapeResult> {
  try {
    const resp = (await chrome.tabs.sendMessage(tabId, {
      type: "SCRAPE",
      source,
      symbol,
    })) as ContentToBackground | undefined;
    if (!resp) return { write: null, error: "No response from content script" };
    if (resp.type === "SCRAPE_RESULT") return { write: resp.write, debug: resp.debug ?? null };
    if (resp.type === "SCRAPE_ERROR") return { write: null, error: resp.error, debug: resp.debug ?? null };
    return { write: null, error: "Unexpected response" };
  } catch (e) {
    // Usually "Could not establish connection" - content script not injected/ready.
    return { write: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Client-rendered SPA sources fetch their data *after* the tab reports
// "complete", so a single parse at load time races the render and comes back
// empty. Re-run the parse a few times - the content script reads the live DOM
// on each SCRAPE - until it yields data or we exhaust the budget.
const SPA_SOURCES: ReadonlySet<SourceId> = new Set<SourceId>([
  "stockoracle",
  "optioncharts",
]);
const SPA_RETRY_ATTEMPTS = 6;
const SPA_RETRY_DELAY_MS = 1500;
// Transient race: the tab reports "complete" before its content script is
// injected, so the first sendMessage rejects with "receiving end does not
// exist". A short retry lets injection finish. Applies to every source.
const CONN_RETRY_ATTEMPTS = 4;
const CONN_RETRY_DELAY_MS = 750;

export function isConnectionError(error: string | undefined): boolean {
  return (
    !!error &&
    /could not establish connection|receiving end does not exist/i.test(error)
  );
}

// Scrape a tab, retrying when the content script isn't yet listening (force-
// inject + retry) and when an SPA source returns genuinely empty (render race).
export async function scrapeWithReadiness(
  tabId: number,
  source: SourceId,
  symbol: string | undefined,
): Promise<ScrapeResult> {
  let result = await scrapeTab(tabId, source, symbol);
  // 1) No listener in the tab: declarative document_idle injection lost the
  // load race, or the page replaced its document (SPA re-render / auth bounce)
  // and tore the listener down. Force-inject the content script, then retry.
  for (let attempt = 0; isConnectionError(result.error) && attempt < CONN_RETRY_ATTEMPTS; attempt++) {
    await ensureContentScript(tabId);
    await delay(CONN_RETRY_DELAY_MS);
    result = await scrapeTab(tabId, source, symbol);
  }
  // 2) SPA sources fetch their data after load; retry while genuinely empty
  // (no write AND no error) so a render-time miss isn't recorded as final.
  if (SPA_SOURCES.has(source)) {
    for (let attempt = 0; !result.write && !result.error && attempt < SPA_RETRY_ATTEMPTS; attempt++) {
      await delay(SPA_RETRY_DELAY_MS);
      result = await scrapeTab(tabId, source, symbol);
    }
  }
  return result;
}

// Short human-readable summary of a scraped write (for the diagnostics list).
// `debug` may carry an `optionsWalk: "full" | "single"` tag (set by the yahoo
// options multi-expiration walker) so the summary line can distinguish a full
// 60-day walk from a single-page poll without inspecting the data shape.
export function summarizeWrite(
  write: ScrapeWrite,
  debug?: Record<string, unknown> | null,
): string {
  if (write.kind === "macro") return `${write.metric} = ${write.value}${write.asOf ? ` (as of ${write.asOf})` : ""}`;
  if (write.kind === "stock_intrinsic") return `intrinsic = ${write.value}`;
  const data = write.data as Record<string, unknown>;
  switch (write.column) {
    case "yahoo_options": {
      // Options chains are large - report counts, not the rows themselves.
      const exps = Array.isArray(data.expirations)
        ? (data.expirations as { puts?: unknown[] }[])
        : [];
      const records = exps.reduce((n, e) => n + (Array.isArray(e.puts) ? e.puts.length : 0), 0);
      const walkTag = debug?.optionsWalk === "full"
        ? " (full walk)"
        : debug?.optionsWalk === "single"
          ? " (single page)"
          : "";
      return `${exps.length} expirations, ${records} records${walkTag}`;
    }
    case "optioncharts": {
      const greeks = Array.isArray(data.greeks) ? data.greeks.length : 0;
      // The per-strike greeks chain is premium-gated on optioncharts. When the
      // page shows the upgrade interstitial the parser sets `greeksPaywalled`;
      // make that explicit in the summary so "0 greek records" stops looking
      // like a parser bug. Overview metrics (IV / put-call) still come back.
      const ivR = data.ivRank;
      const iv = typeof ivR === "number" ? ` ivRank=${ivR}%` : "";
      if (data.greeksPaywalled) return `greeks paywalled${iv}`;
      return `${greeks} greek records${iv}`;
    }
    case "yahoo_analysis": {
      const eps = Array.isArray(data.epsEstimate) ? data.epsEstimate.length : 0;
      const rev = Array.isArray(data.revenueEstimate) ? data.revenueEstimate.length : 0;
      return `${eps} EPS, ${rev} revenue periods`;
    }
    case "finviz":
      return `price=${String(data.price ?? "?")}, rsi=${String(data.rsi14 ?? "?")}`;
    default:
      return "scraped";
  }
}

// Stable string for change detection between polls.
export function serializeWrite(write: ScrapeWrite | null): string {
  if (!write) return "";
  if (write.kind === "stock_json") return JSON.stringify(write.data);
  if (write.kind === "stock_intrinsic") return String(write.value);
  return `${write.value}|${write.asOf ?? ""}`;
}

export async function persistWrite(write: ScrapeWrite): Promise<void> {
  const sb = getSupabase();
  const now = new Date().toISOString();

  if (write.kind === "macro") {
    await sb
      .from("macro_data")
      .upsert(
        { metric: write.metric, value: write.value, as_of: write.asOf ?? null, updated_at: now },
        { onConflict: "metric" },
      );
    return;
  }

  if (write.kind === "stock_intrinsic") {
    await sb
      .from("stocks")
      .upsert(
        { symbol: write.symbol.toUpperCase(), intrinsic_value: write.value, intrinsic_updated_at: now },
        { onConflict: "symbol" },
      );
    return;
  }

  // stock_json - set the right column + its updated_at (exhaustive over columns).
  const symbol = write.symbol.toUpperCase();
  const data = write.data as unknown as Json;
  switch (write.column) {
    case "yahoo_options":
      await sb.from("stocks").upsert({ symbol, yahoo_options: data, yahoo_options_updated_at: now }, { onConflict: "symbol" });
      return;
    case "optioncharts":
      await sb.from("stocks").upsert({ symbol, optioncharts: data, optioncharts_updated_at: now }, { onConflict: "symbol" });
      return;
    case "yahoo_analysis":
      await sb.from("stocks").upsert({ symbol, yahoo_analysis: data, yahoo_analysis_updated_at: now }, { onConflict: "symbol" });
      return;
    case "finviz":
      await sb.from("stocks").upsert({ symbol, finviz: data, finviz_updated_at: now }, { onConflict: "symbol" });
      return;
    default: {
      const _exhaustive: never = write.column;
      void _exhaustive;
    }
  }
}
