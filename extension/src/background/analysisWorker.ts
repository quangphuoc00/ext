// Owner: Agent D (analysis). Subscribes to analysis_requests via Supabase
// Realtime; for each pending request it builds the data-injected CSP prompt,
// acquires the persistent claude.ai tab (reused in place across analyses —
// no page reload between requests), sends RUN_CLAUDE to the content script,
// awaits the streamed answer, parses the trailing JSON verdict, writes an
// analyses row, and marks the request done/error.
import { buildPrompt } from "@optionpilot/contracts";
import type {
  AnalysisMode,
  BackgroundToContent,
  ContentToBackground,
  Database,
  PromptInput,
  YahooOptionsData,
} from "@optionpilot/contracts";
import { getSupabase } from "../supabase/client";
import { acquireClaudeTab } from "./claudeTab";
import {
  noteAnalysisRequestReceived,
  noteAnalysisRequestsChecked,
  noteAnalysisSymbolClaimed,
  setAnalysisRequestsWatching,
} from "./diagnostics";
import { parseVerdict } from "./verdict";
import {
  formatFinviz,
  formatMacro,
  formatOptioncharts,
  formatYahooAnalysis,
  formatYahooOptions,
  type MacroRowLike,
} from "./analysisFormat";

const CLAUDE_TIMEOUT_MS = 180_000;
// How long we keep retrying tabs.sendMessage until the content script is alive.
const CONTENT_READY_TIMEOUT_MS = 60_000;
const SEND_RETRY_MS = 500;
// Realtime can silently drop INSERT events (channel error, SW asleep at the
// moment of insert, RLS auth gaps). A short recovery poll guarantees a stuck
// `pending` row is picked up within one interval instead of waiting for the
// next service-worker boot. enqueue() + the atomic pending->running claim make
// re-sweeping idempotent, so polling never double-processes a request.
const RECOVERY_POLL_MS = 5_000;

type AnalysisRequestRow = Database["public"]["Tables"]["analysis_requests"]["Row"];

let started = false;
const queue: string[] = [];
const queued = new Set<string>();
let draining = false;
let sweeping = false;

export function startAnalysisWorker(): void {
  // Guard so a service-worker restart (which re-runs the entrypoint) does not
  // register the realtime subscription twice within one SW lifetime.
  if (started) return;
  started = true;
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  const supabase = getSupabase();

  // Admin build: the service-role key bypasses RLS, so no sign-in is needed and
  // requests from every user are visible.
  // Live path: react to new analysis_requests as they are inserted.
  supabase
    .channel("analysis_requests_worker")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "analysis_requests" },
      (payload) => {
        const id = (payload.new as { id?: string }).id;
        if (id) {
          noteAnalysisRequestReceived(id);
          console.info(`[analysis_requests] new request received: ${id}`);
          enqueue(id);
        }
      },
    )
    .subscribe((status) => {
      setAnalysisRequestsWatching(status);
      console.info(`[analysis_requests] realtime subscription: ${status}`);
    });

  // Recovery path: pick up anything that was inserted while the SW was asleep.
  await processExistingPending();

  // Keep sweeping on a short interval so a missed realtime event self-heals
  // (see RECOVERY_POLL_MS). While awake the worker re-checks every 5s.
  setInterval(() => {
    void processExistingPending();
  }, RECOVERY_POLL_MS);
}

async function processExistingPending(): Promise<void> {
  // Skip if a prior sweep is still in flight so slow queries don't pile up.
  if (sweeping) return;
  sweeping = true;
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("analysis_requests")
      .select("id")
      .eq("status", "pending");
    noteAnalysisRequestsChecked();
    if (error || !data) return;
    if (data.length > 0) {
      console.info(`[analysis_requests] recovery sweep: ${data.length} pending`);
    }
    for (const row of data) enqueue(row.id);
  } finally {
    sweeping = false;
  }
}

function enqueue(id: string): void {
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
  void drain();
}

// Process requests one at a time: a single claude.ai tab is driven at once.
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      queued.delete(id);
      try {
        await processRequest(id);
      } catch (e) {
        // processRequest persists its own errors; this is a last-resort backstop.
        console.error("[analysisWorker] unhandled failure for request", id, e);
      }
    }
  } finally {
    draining = false;
  }
}

async function processRequest(id: string): Promise<void> {
  const supabase = getSupabase();

  // Atomically claim the row: only transition pending -> running. If no row
  // comes back, another consumer (or a prior pass) already took it -> skip.
  const { data: claimed, error: claimErr } = await supabase
    .from("analysis_requests")
    .update({ status: "running" })
    .eq("id", id)
    .eq("status", "pending")
    .select()
    .maybeSingle();
  if (claimErr || !claimed) return;

  const req = claimed;
  noteAnalysisSymbolClaimed(req.symbol);
  console.info(`[analysisWorker] claimed request for symbol: ${req.symbol}`);
  try {
    const prompt = await buildPromptForRequest(req);
    const text = await runClaude(prompt);
    const parsed = parseVerdict(text);

    const { error: insertErr } = await supabase.from("analyses").insert({
      user_id: req.user_id,
      symbol: req.symbol,
      mode: req.mode,
      verdict: parsed.verdict,
      score_pass: parsed.score_pass,
      score_total: parsed.score_total,
      recommended_strike: parsed.recommended_strike,
      recommended_expiry: parsed.recommended_expiry,
      why: parsed.why,
      decision: parsed.decision,
      raw_response: text,
    });
    if (insertErr) throw new Error(`analyses insert failed: ${insertErr.message}`);

    await supabase
      .from("analysis_requests")
      .update({
        status: "done",
        error: null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabase
      .from("analysis_requests")
      .update({
        status: "error",
        error: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", id);
  }
}

async function buildPromptForRequest(req: AnalysisRequestRow): Promise<string> {
  const supabase = getSupabase();
  const symbol = req.symbol;

  const [stockRes, profileRes, macroRes] = await Promise.all([
    supabase.from("stocks").select("*").eq("symbol", symbol).maybeSingle(),
    supabase
      .from("profiles")
      .select("cash, total_account_value")
      .eq("user_id", req.user_id)
      .maybeSingle(),
    supabase.from("macro_data").select("metric, value, as_of"),
  ]);

  const stock = stockRes.data;
  const profile = profileRes.data;
  const macroRows = (macroRes.data ?? []) as MacroRowLike[];

  const mode: AnalysisMode = req.mode ?? "routine";
  const asOfDate = new Date().toISOString().slice(0, 10);

  // Short-circuit obviously-doomed requests so we don't burn a 180s Claude
  // turn on a chain that will FAIL precheck A or B'. The throw is caught by
  // processRequest, which writes status=error + this message to the request
  // row so the dashboard shows the actual reason instead of a timeout.
  rejectIfPrecheckObviouslyFails(symbol, stock?.yahoo_options, asOfDate);

  // Pull the underlying price from the persisted Yahoo chain so the
  // OptionCharts formatter can compute a dollar expected move when the
  // OptionCharts tile selector missed.
  const underlyingPrice = readUnderlyingPrice(stock?.yahoo_options);

  const input: PromptInput = {
    symbol,
    mode,
    asOfDate,
    totalAccountValue: profile?.total_account_value ?? null,
    cashAvailable: profile?.cash ?? null,
    intrinsicValue: stock?.intrinsic_value ?? null,
    scraped: {
      yahooOptions: formatYahooOptions(stock?.yahoo_options, asOfDate),
      optioncharts: formatOptioncharts(stock?.optioncharts, underlyingPrice),
      yahooAnalysis: formatYahooAnalysis(stock?.yahoo_analysis),
      finviz: formatFinviz(stock?.finviz, asOfDate),
      macro: formatMacro(macroRows),
    },
  };
  return buildPrompt(input);
}

function readUnderlyingPrice(yahooOptions: unknown): number | null {
  if (!yahooOptions || typeof yahooOptions !== "object") return null;
  const d = yahooOptions as YahooOptionsData;
  return typeof d.price === "number" ? d.price : null;
}

// Throws when the persisted chain would deterministically FAIL precheck A
// (no 30-45 DTE expiry) or precheck B'/B (non-REGULAR market state, or every
// bid/ask zero). Lets us reject the request with a clear reason before the
// Claude round-trip. No-op when the chain isn't persisted yet (the prompt
// builder will mark Yahoo "not available" and Claude reports it as unknown).
function rejectIfPrecheckObviouslyFails(
  symbol: string,
  yahooOptions: unknown,
  asOfDate: string,
): void {
  if (!yahooOptions || typeof yahooOptions !== "object") return;
  const d = yahooOptions as YahooOptionsData;
  if (!Array.isArray(d.expirations) || d.expirations.length === 0) return;

  const asOfMs = Date.parse(`${asOfDate}T00:00:00Z`);
  const dteList = d.expirations
    .map((e) => {
      const t = Date.parse(`${e.expiry}T00:00:00Z`);
      return Number.isFinite(t) ? Math.round((t - asOfMs) / 86_400_000) : null;
    })
    .filter((v): v is number => v != null);
  const hasEntryWindow = dteList.some((d) => d >= 30 && d <= 45);
  if (!hasEntryWindow) {
    const maxDte = dteList.length > 0 ? Math.max(...dteList) : -1;
    throw new Error(
      `${symbol}: no 30-45 DTE expiry in stored chain (max DTE=${maxDte}); rescrape yahoo_options when the July monthly is listed.`,
    );
  }

  if (d.marketState && d.marketState !== "REGULAR" && d.marketState !== "UNKNOWN") {
    throw new Error(
      `${symbol}: yahoo_options snapshot was taken while market state = ${d.marketState}; rescrape during regular trading hours.`,
    );
  }
}

// Acquires the persistent claude.ai tab (reusing it in place — no page
// reload between analyses; each prompt is appended as the next turn in
// whatever conversation is currently open), drives the content script,
// and returns the answer.
async function runClaude(prompt: string): Promise<string> {
  const tabId = await acquireClaudeTab();
  return await exchangeWithContent(tabId, prompt);
}

// Sends RUN_CLAUDE (with delivery retries) and waits for the content script to
// reply with CLAUDE_RESULT / CLAUDE_ERROR, scoped to this tab, under a timeout.
function exchangeWithContent(tabId: number, prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(onMessage);
      clearTimeout(timer);
      fn();
    };
    const onMessage = (
      msg: ContentToBackground,
      sender: chrome.runtime.MessageSender,
    ): void => {
      if (sender.tab?.id !== tabId) return;
      if (msg?.type === "CLAUDE_RESULT") {
        finish(() => resolve(msg.text));
      } else if (msg?.type === "CLAUDE_ERROR") {
        finish(() => reject(new Error(msg.error)));
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);

    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`claude.ai analysis timed out after ${CLAUDE_TIMEOUT_MS}ms`)),
      );
    }, CLAUDE_TIMEOUT_MS);

    void deliverPrompt(tabId, prompt).catch((e: unknown) => {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    });
  });
}

// The content script loads at document_idle and may not be ready the instant
// the tab is created; retry until sendMessage is received (no "Receiving end"
// rejection) or we give up.
async function deliverPrompt(tabId: number, prompt: string): Promise<void> {
  const message: BackgroundToContent = { type: "RUN_CLAUDE", prompt };
  const deadline = Date.now() + CONTENT_READY_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return; // delivered: the content script listener received the prompt
    } catch (e) {
      lastErr = e;
      await delay(SEND_RETRY_MS);
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`claude.ai content script never became ready: ${detail}`);
}


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
