// Owner: Agent A (extension engine). In-memory diagnostics for the current/last
// run, surfaced in the popup and serialized into a copy-paste blob for debugging.
import {
  emptyAnalysisRequestsIndicator,
  emptyDiagnostics,
  emptyScrapeRequestsIndicator,
  jobKey,
  type AnalysisRequestsIndicator,
  type Diagnostics,
  type JobDiagnostic,
  type JobStatus,
  type ScrapeRequestsIndicator,
  type SourceId,
} from "@optionpilot/contracts";

let state: Diagnostics = emptyDiagnostics();

// The scrape_requests indicator tracks the trigger path's liveness, which is
// independent of any single run. Keep it in a module-level var so it survives
// resetDiagnostics() (which clears the per-run jobs/errors at the start of each
// update) instead of being wiped every time a run begins.
let scrapeRequests: ScrapeRequestsIndicator = emptyScrapeRequestsIndicator();

// Liveness for the analysis_requests trigger path (claude.ai worker). Tracked
// separately from scrapeRequests because the analysis worker subscribes to a
// different table and can fail independently. Module-level for the same
// survive-resetDiagnostics() reason as scrapeRequests above.
let analysisRequests: AnalysisRequestsIndicator = emptyAnalysisRequestsIndicator();

export function getDiagnostics(): Diagnostics {
  return state;
}

export function resetDiagnostics(init: Partial<Diagnostics>): void {
  state = {
    ...emptyDiagnostics(),
    extensionVersion: chrome.runtime.getManifest().version,
    startedAt: new Date().toISOString(),
    ...init,
    jobs: init.jobs ?? [],
    errors: [],
    scrapeRequests,
    analysisRequests,
  };
  pushDiagnostics();
}

// Record the live Realtime subscription status for scrape_requests.
export function setScrapeRequestsWatching(subStatus: string): void {
  scrapeRequests = {
    ...scrapeRequests,
    watching: subStatus === "SUBSCRIBED",
    subStatus,
  };
  syncScrapeRequests();
}

// Record that a new pending scrape_request arrived via Realtime.
export function noteScrapeRequestReceived(id: string): void {
  scrapeRequests = {
    ...scrapeRequests,
    received: scrapeRequests.received + 1,
    lastEventAt: new Date().toISOString(),
    lastRequestId: id,
  };
  syncScrapeRequests();
}

// Record that the recovery sweep just polled the table for pending rows.
export function noteScrapeRequestsChecked(): void {
  scrapeRequests = {
    ...scrapeRequests,
    lastCheckedAt: new Date().toISOString(),
  };
  syncScrapeRequests();
}

function syncScrapeRequests(): void {
  state = { ...state, scrapeRequests };
  pushDiagnostics();
}

// Record the live Realtime subscription status for analysis_requests.
export function setAnalysisRequestsWatching(subStatus: string): void {
  analysisRequests = {
    ...analysisRequests,
    watching: subStatus === "SUBSCRIBED",
    subStatus,
  };
  syncAnalysisRequests();
}

// Record that a new pending analysis_request arrived via Realtime.
export function noteAnalysisRequestReceived(id: string): void {
  analysisRequests = {
    ...analysisRequests,
    received: analysisRequests.received + 1,
    lastEventAt: new Date().toISOString(),
    lastRequestId: id,
  };
  syncAnalysisRequests();
}

// Record that the recovery sweep just polled the table for pending rows.
export function noteAnalysisRequestsChecked(): void {
  analysisRequests = {
    ...analysisRequests,
    lastCheckedAt: new Date().toISOString(),
  };
  syncAnalysisRequests();
}

// Record which symbol was just claimed for analysis.
export function noteAnalysisSymbolClaimed(symbol: string): void {
  analysisRequests = { ...analysisRequests, lastSymbol: symbol };
  syncAnalysisRequests();
}

function syncAnalysisRequests(): void {
  state = { ...state, analysisRequests };
  pushDiagnostics();
}

export function setRunning(running: boolean): void {
  state = {
    ...state,
    running,
    finishedAt: running ? undefined : new Date().toISOString(),
    // Clearing the countdown when the run ends avoids a stale "next window"
    // lingering after the final symbol completes.
    countdown: running ? state.countdown : undefined,
  };
  pushDiagnostics();
}

// Mark that the orchestrator is waiting out the stagger delay before opening
// the next symbol window. Pass `undefined` to clear it once the wait is over.
export function setCountdown(nextWindowAt: string | undefined, label?: string): void {
  state = {
    ...state,
    countdown: nextWindowAt ? { nextWindowAt, label } : undefined,
  };
  pushDiagnostics();
}

export function seedJob(source: SourceId, symbol: string | undefined, url: string): void {
  const key = jobKey(source, symbol);
  const existing = state.jobs.find((j) => j.key === key);
  if (existing) return;
  state.jobs = [
    ...state.jobs,
    { key, source, symbol, url, status: "pending", updatedAt: new Date().toISOString() },
  ];
  pushDiagnostics();
}

export function updateJob(
  source: SourceId,
  symbol: string | undefined,
  patch: Partial<Omit<JobDiagnostic, "key" | "source" | "symbol">> & { status?: JobStatus },
): void {
  const key = jobKey(source, symbol);
  let found = false;
  state.jobs = state.jobs.map((j) => {
    if (j.key !== key) return j;
    found = true;
    return { ...j, ...patch, updatedAt: new Date().toISOString() };
  });
  if (!found) {
    state.jobs = [
      ...state.jobs,
      {
        key,
        source,
        symbol,
        url: patch.url ?? "",
        status: patch.status ?? "pending",
        ...patch,
        updatedAt: new Date().toISOString(),
      },
    ];
  }
  pushDiagnostics();
}

export function addError(where: string, message: string): void {
  state.errors = [...state.errors, { when: new Date().toISOString(), where, message }];
  pushDiagnostics();
}

export function setMeta(meta: Partial<Pick<Diagnostics, "settings">>): void {
  state = { ...state, ...meta };
  pushDiagnostics();
}

function pushDiagnostics(): void {
  try {
    void chrome.runtime.sendMessage({ type: "DIAGNOSTICS", diagnostics: state });
  } catch {
    // no popup open
  }
}
