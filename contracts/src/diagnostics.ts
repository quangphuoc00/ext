// Shared diagnostics shapes surfaced in the extension popup and copied for debugging.
import type { SourceId } from "./scraper";

export type JobStatus =
  | "pending" // queued, window not opened yet
  | "opening" // window/tab created
  | "loading" // tab open, waiting for page to finish
  | "scraped" // parser returned data, persisted
  | "empty" // parser ran but found no data (likely selector miss)
  | "error"; // parser threw / no receiver / persist failed

export interface JobDiagnostic {
  key: string; // `${source}:${symbol ?? ""}`
  source: SourceId;
  symbol?: string;
  url: string;
  status: JobStatus;
  message?: string; // error text or note
  dataSummary?: string; // short human-readable summary of what was scraped
  data?: unknown; // raw write payload (for the copy blob)
  debug?: unknown; // raw per-source DOM probe (for fixing selectors from a copy)
  scrapeCount?: number; // how many times this tab has been scraped (polling)
  updatedAt?: string; // ISO of last status change
}

export interface DiagnosticError {
  when: string; // ISO
  where: string; // e.g. "runUpdate", "AAPL optioncharts"
  message: string;
}

// Liveness indicator for a Realtime request-trigger path (independent of any
// single run). Lets the popup show that the extension is actually watching the
// table and reacting to new rows.
export interface RequestsIndicator {
  watching: boolean; // Realtime subscription currently SUBSCRIBED
  subStatus?: string; // last Realtime status (SUBSCRIBED, CHANNEL_ERROR, …)
  received: number; // count of new pending rows observed live since boot
  lastEventAt?: string; // ISO of the last new request seen via Realtime
  lastRequestId?: string; // id of the last new request seen
  lastCheckedAt?: string; // ISO of the last recovery sweep (poll of pending rows)
  lastSymbol?: string; // symbol of the last analysis request that was claimed
}

// Trigger path for scrape_requests -> scrapeOrchestrator (data scraping).
export type ScrapeRequestsIndicator = RequestsIndicator;

// Trigger path for analysis_requests -> analysisWorker (claude.ai analysis).
// Same shape as the scrape indicator; tracked separately because the two
// workers subscribe to different tables and can fail independently.
export type AnalysisRequestsIndicator = RequestsIndicator;

// Live countdown to the next staggered symbol window opening. Present only
// while the orchestrator is waiting out the stagger delay between windows; the
// monitor/popup tick a local timer off `nextWindowAt` to show seconds remaining.
export interface Countdown {
  nextWindowAt: string; // ISO of when the next window opens
  label?: string; // what opens next, e.g. "AAPL"
}

export interface Diagnostics {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  extensionVersion?: string;
  settings?: {
    staggerDelayMs: number;
    pollIntervalMs: number;
    stableCloseCount: number;
  };
  jobs: JobDiagnostic[];
  errors: DiagnosticError[];
  scrapeRequests: ScrapeRequestsIndicator;
  analysisRequests: AnalysisRequestsIndicator;
  countdown?: Countdown;
}

export function emptyScrapeRequestsIndicator(): ScrapeRequestsIndicator {
  return { watching: false, received: 0 };
}

export function emptyAnalysisRequestsIndicator(): AnalysisRequestsIndicator {
  return { watching: false, received: 0 };
}

export function emptyDiagnostics(): Diagnostics {
  return {
    running: false,
    jobs: [],
    errors: [],
    scrapeRequests: emptyScrapeRequestsIndicator(),
    analysisRequests: emptyAnalysisRequestsIndicator(),
  };
}

export function jobKey(source: SourceId, symbol?: string): string {
  return `${source}:${symbol ?? ""}`;
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max)}\n…(truncated ${s.length - max} chars)` : s;
}

// Full plain-text report for the popup's "Copy diagnostics" button.
export function formatDiagnostics(d: Diagnostics): string {
  const lines: string[] = [];
  lines.push("=== OptionPilot extension diagnostics ===");
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`extensionVersion: ${d.extensionVersion ?? "?"}`);
  lines.push(`running: ${d.running}`);
  lines.push(`startedAt: ${d.startedAt ?? "-"}  finishedAt: ${d.finishedAt ?? "-"}`);
  if (d.settings) {
    lines.push(
      `settings: stagger=${d.settings.staggerDelayMs}ms poll=${d.settings.pollIntervalMs}ms stableClose=${d.settings.stableCloseCount}`,
    );
  }

  const counts = d.jobs.reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(
    `jobs: ${d.jobs.length} total | ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );

  const sr = d.scrapeRequests;
  if (sr) {
    lines.push(
      `scrape_requests: watching=${sr.watching}` +
        ` status=${sr.subStatus ?? "-"}` +
        ` received=${sr.received}` +
        ` lastEvent=${sr.lastEventAt ?? "-"}${sr.lastRequestId ? ` (${sr.lastRequestId})` : ""}` +
        ` lastChecked=${sr.lastCheckedAt ?? "-"}`,
    );
  }
  const ar = d.analysisRequests;
  if (ar) {
    lines.push(
      `analysis_requests: watching=${ar.watching}` +
        ` status=${ar.subStatus ?? "-"}` +
        ` received=${ar.received}` +
        ` lastEvent=${ar.lastEventAt ?? "-"}${ar.lastRequestId ? ` (${ar.lastRequestId})` : ""}` +
        ` lastChecked=${ar.lastCheckedAt ?? "-"}` +
        (ar.lastSymbol ? ` lastSymbol=${ar.lastSymbol}` : ""),
    );
  }
  lines.push("");

  lines.push("--- JOBS ---");
  for (const j of d.jobs) {
    lines.push(
      `[${j.status.toUpperCase()}] ${j.symbol ?? "MACRO"} / ${j.source}` +
        (j.scrapeCount ? `  (scraped ${j.scrapeCount}x)` : ""),
    );
    lines.push(`  url: ${j.url}`);
    if (j.dataSummary) lines.push(`  summary: ${j.dataSummary}`);
    if (j.message) lines.push(`  message: ${j.message}`);
    // Only dump the heavy raw payload/DOM probe for jobs that need debugging.
    // Successful scrapes keep just the one-line summary to save tokens — except:
    //   * stockoracle: login-gated, still being stabilized, so always surface
    //     its (small) probe to verify the value.
    //   * optioncharts: this is a cash-secured-put tool, so a "scraped" job
    //     that reports `0 greek records` is a silent data-quality miss (the
    //     overview metrics flip `hasAny=true` even when the puts greeks table
    //     never resolved). Always surface its probe so the DOM evidence is in
    //     the copy blob.
    //   * any other source that reports "0 <something> records" — same silent
    //     miss pattern, e.g. yahoo_options with "0 expirations, 0 records".
    //     Matches "0 records" with or without an intermediate qualifier word,
    //     and tolerates a comma between counts (so the trailing "0 records"
    //     half of "1 expirations, 0 records" still triggers a probe dump).
    const zeroRecords = /(^|\W)0 (?:\w+ )?records?\b/.test(j.dataSummary ?? "");
    const needsDetail =
      j.status === "error" ||
      j.status === "empty" ||
      j.source === "stockoracle" ||
      j.source === "optioncharts" ||
      zeroRecords;
    if (needsDetail) {
      if (j.data !== undefined && j.data !== null) {
        lines.push("  data:");
        lines.push(truncate(JSON.stringify(j.data, null, 2)));
      }
      if (j.debug !== undefined && j.debug !== null) {
        lines.push("  debug (raw DOM probe):");
        lines.push(truncate(JSON.stringify(j.debug, null, 2)));
      }
    }
    lines.push("");
  }

  lines.push("--- ERRORS ---");
  if (d.errors.length === 0) {
    lines.push("(none)");
  } else {
    for (const e of d.errors) lines.push(`[${e.when}] ${e.where}: ${e.message}`);
  }

  return lines.join("\n");
}
