"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnalysisMode, Database } from "@optionpilot/contracts";
import { createClient } from "./lib/db";
import {
  Badge,
  Button,
  Card,
  Icon,
  IconButton,
  SegmentedControl,
  Skeleton,
  StatusBadge,
  Stat,
} from "./lib/ui";
import {
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
  relativeTime,
  useNow,
} from "./lib/format";
import {
  readFinviz,
  readOptioncharts,
  readPrice,
  type StockRow,
} from "./lib/stocks";

type WatchlistEntry = Database["public"]["Tables"]["watchlist"]["Row"];
type Analysis = Database["public"]["Tables"]["analyses"]["Row"];
type AnalysisRequest = Database["public"]["Tables"]["analysis_requests"]["Row"];

const IBKR_POSITIONS_URL =
  "https://portal.interactivebrokers.com/portal/?loginType=1&action=ACCT_MGMT_MAIN&RL=1&locale=en_US#/dashboard/positions";

const MODE_OPTIONS: { value: AnalysisMode; label: string }[] = [
  { value: "routine", label: "Routine" },
  { value: "dip_buy", label: "Dip buy" },
];

function latestPerSymbol(rows: Analysis[]): Record<string, Analysis> {
  const map: Record<string, Analysis> = {};
  for (const row of rows) {
    const existing = map[row.symbol];
    if (!existing || new Date(row.created_at) > new Date(existing.created_at)) {
      map[row.symbol] = row;
    }
  }
  return map;
}

function latestRequestPerSymbol(
  rows: AnalysisRequest[],
): Record<string, AnalysisRequest> {
  const map: Record<string, AnalysisRequest> = {};
  for (const row of rows) {
    const existing = map[row.symbol];
    if (
      !existing ||
      new Date(row.requested_at) > new Date(existing.requested_at)
    ) {
      map[row.symbol] = row;
    }
  }
  return map;
}

export default function Watchlist() {
  const supabase = useMemo(() => createClient(), []);
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [stocks, setStocks] = useState<Record<string, StockRow>>({});
  const [analyses, setAnalyses] = useState<Record<string, Analysis>>({});
  const [requests, setRequests] = useState<Record<string, AnalysisRequest>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [modes, setModes] = useState<Record<string, AnalysisMode>>({});
  const [symbolInput, setSymbolInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useNow(60_000);

  const watchedSymbols = useMemo(
    () => entries.map((e) => e.symbol),
    [entries],
  );

  async function loadStocks(symbols: string[]) {
    if (symbols.length === 0) return;
    const { data } = await supabase.from("stocks").select("*").in("symbol", symbols);
    if (data) {
      setStocks((prev) => {
        const next = { ...prev };
        for (const row of data) next[row.symbol] = row;
        return next;
      });
    }
  }

  useEffect(() => {
    let active = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function init() {
      const [watchRes, analysisRes, requestRes] = await Promise.all([
        supabase.from("watchlist").select("*").order("created_at", { ascending: true }),
        supabase
          .from("analyses")
          .select("*")
          .order("created_at", { ascending: false }),
        supabase
          .from("analysis_requests")
          .select("*")
          .order("requested_at", { ascending: false }),
      ]);
      if (!active) return;
      const watch = watchRes.data ?? [];
      setEntries(watch);
      setAnalyses(latestPerSymbol(analysisRes.data ?? []));
      setRequests(latestRequestPerSymbol(requestRes.data ?? []));
      await loadStocks(watch.map((w) => w.symbol));
      if (active) setLoading(false);
    }

    async function setup() {
      // The channel must join with the user's access token, otherwise the
      // server evaluates the RLS on postgres_changes with no auth.uid() and
      // silently drops every owner-scoped event (watchlist, analyses,
      // analysis_requests) while public tables like stocks still stream.
      // supabase-js only re-applies the token on SIGNED_IN / TOKEN_REFRESHED,
      // not on INITIAL_SESSION (a reload that restores the cookie session), so
      // we set it explicitly and await it before subscribing.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!active) return;
      if (session) await supabase.realtime.setAuth(session.access_token);
      if (!active) return;

      void init();

      channel = supabase
        .channel("watchlist-feed")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "stocks" },
          (payload) => {
            const row = payload.new;
            if (!row || !("symbol" in row)) return;
            const stock = row as StockRow;
            setStocks((prev) => ({ ...prev, [stock.symbol]: stock }));
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "analyses" },
          (payload) => {
            const row = payload.new;
            if (!row || !("symbol" in row)) return;
            const analysis = row as Analysis;
            setAnalyses((prev) => {
              const existing = prev[analysis.symbol];
              if (
                existing &&
                new Date(existing.created_at) >= new Date(analysis.created_at)
              ) {
                return prev;
              }
              return { ...prev, [analysis.symbol]: analysis };
            });
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "analysis_requests" },
          (payload) => {
            const row = payload.new;
            if (!row || !("symbol" in row)) return;
            const req = row as AnalysisRequest;
            setRequests((prev) => {
              const existing = prev[req.symbol];
              // Only ignore events from a different, older request for this
              // symbol. Status transitions (pending -> running -> done) reuse
              // the same id and requested_at, so comparing requested_at alone
              // would let a late/out-of-order event overwrite a newer status.
              if (
                existing &&
                existing.id !== req.id &&
                new Date(existing.requested_at) > new Date(req.requested_at)
              ) {
                return prev;
              }
              return { ...prev, [req.symbol]: req };
            });
          },
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "watchlist" },
          (payload) => {
            const row = payload.new;
            if (!row || !("id" in row)) return;
            const entry = row as WatchlistEntry;
            setEntries((prev) =>
              prev.some((e) => e.id === entry.id) ? prev : [...prev, entry],
            );
            void loadStocks([entry.symbol]);
          },
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: "watchlist" },
          (payload) => {
            const row = payload.old;
            if (!row || !("id" in row)) return;
            const removedId = (row as WatchlistEntry).id;
            setEntries((prev) => prev.filter((e) => e.id !== removedId));
          },
        )
        .subscribe();
    }

    void setup();

    return () => {
      active = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase]);

  async function addSymbol(e: React.FormEvent) {
    e.preventDefault();
    const symbol = symbolInput.trim().toUpperCase();
    setError(null);
    if (!symbol) return;
    if (watchedSymbols.includes(symbol)) {
      setSymbolInput("");
      return;
    }
    const { data, error: insertError } = await supabase
      .from("watchlist")
      .insert({ symbol })
      .select()
      .single();
    if (insertError) {
      setError(insertError.message);
      return;
    }
    if (data) {
      setEntries((prev) => [...prev, data]);
      setSymbolInput("");
      await loadStocks([symbol]);
    }
  }

  async function removeSymbol(entry: WatchlistEntry) {
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    const { error: delError } = await supabase
      .from("watchlist")
      .delete()
      .eq("id", entry.id);
    if (delError) setError(delError.message);
  }

  async function runAnalysis(symbol: string) {
    const mode = modes[symbol] ?? "routine";
    setError(null);
    setSubmitting((prev) => ({ ...prev, [symbol]: true }));

    // Pre-flight: every analysis evaluates GATEs 6.1-6.3 which require Total
    // account value. Without it those GATEs FAIL deterministically (per the
    // prompt's "Unknown GATE -> FAILS" rule), wasting a Claude turn. Block
    // the request here with a clear UX message instead of inserting a row
    // that will land at verdict=FAIL.
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("total_account_value")
      .maybeSingle();
    if (profileError) {
      setSubmitting((prev) => ({ ...prev, [symbol]: false }));
      setError(`Could not read profile: ${profileError.message}`);
      return;
    }
    if (profile?.total_account_value == null) {
      setSubmitting((prev) => ({ ...prev, [symbol]: false }));
      setError(
        "Set your total account value in the Account card before running an analysis (CSP sizing GATEs 6.1-6.3 require it).",
      );
      return;
    }

    const { data, error: reqError } = await supabase
      .from("analysis_requests")
      .insert({ symbol, mode, status: "pending" })
      .select()
      .single();
    setSubmitting((prev) => ({ ...prev, [symbol]: false }));
    if (reqError) {
      // A duplicate active request (same symbol + mode already pending/running)
      // is rejected by the DB's partial unique index (0003). That rejection is
      // the intended global dedupe, so surface the in-flight request instead of
      // an error.
      if (reqError.code === "23505") {
        const { data: existing } = await supabase
          .from("analysis_requests")
          .select("*")
          .eq("symbol", symbol)
          .eq("mode", mode)
          .in("status", ["pending", "running"])
          .order("requested_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existing) setRequests((prev) => ({ ...prev, [symbol]: existing }));
        return;
      }
      setError(reqError.message);
      return;
    }
    if (data) setRequests((prev) => ({ ...prev, [symbol]: data }));
  }

  return (
    <Card
      title="Watchlist"
      subtitle={
        entries.length > 0 ? `${entries.length} symbol${entries.length === 1 ? "" : "s"}` : undefined
      }
      actions={
        <form onSubmit={addSymbol} className="flex items-center gap-2">
          <input
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            placeholder="AAPL"
            aria-label="Add symbol"
            className="w-24 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm uppercase tracking-wider placeholder:normal-case placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900"
          />
          <Button type="submit" tone="primary" size="sm" disabled={!symbolInput.trim()}>
            <Icon.Plus width={14} height={14} /> Add
          </Button>
        </form>
      }
    >
      {error && (
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
      {loading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-32 w-full rounded-lg" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <WatchlistRow
              key={entry.id}
              entry={entry}
              stock={stocks[entry.symbol]}
              analysis={analyses[entry.symbol]}
              request={requests[entry.symbol]}
              submitting={submitting[entry.symbol] ?? false}
              mode={modes[entry.symbol] ?? "routine"}
              onModeChange={(m) =>
                setModes((prev) => ({ ...prev, [entry.symbol]: m }))
              }
              onRun={() => runAnalysis(entry.symbol)}
              onRemove={() => removeSymbol(entry)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-neutral-200 px-6 py-10 text-center dark:border-neutral-800">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-900/40 dark:text-brand-300">
        <Icon.Plus width={18} height={18} />
      </div>
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        Watchlist is empty
      </p>
      <p className="mt-1 max-w-xs text-xs text-neutral-500">
        Add a ticker above to start tracking price, IV rank, fundamentals, and
        run cash-secured put analyses.
      </p>
    </div>
  );
}

// Single combined freshness pill: shows the oldest source so the user can tell
// at a glance whether anything is stale, with full per-source breakdown on hover.
function FreshnessPill({ stock }: { stock: StockRow | undefined }) {
  const sources: { key: string; label: string; at: string | null | undefined }[] = [
    { key: "finviz", label: "Finviz", at: stock?.finviz_updated_at },
    { key: "opts", label: "Yahoo opts", at: stock?.yahoo_options_updated_at },
    { key: "ivr", label: "IV rank", at: stock?.optioncharts_updated_at },
    { key: "anlys", label: "Yahoo analysis", at: stock?.yahoo_analysis_updated_at },
    { key: "intr", label: "Intrinsic", at: stock?.intrinsic_updated_at },
  ];

  let oldestMs: number | null = null;
  let oldestRel: string | null = null;
  let missing = 0;
  for (const s of sources) {
    if (!s.at) {
      missing += 1;
      continue;
    }
    const t = new Date(s.at).getTime();
    if (!Number.isFinite(t)) continue;
    if (oldestMs === null || t < oldestMs) {
      oldestMs = t;
      oldestRel = relativeTime(s.at) ?? null;
    }
  }

  const ageHours =
    oldestMs === null ? null : (Date.now() - oldestMs) / (1000 * 60 * 60);
  const tone: "green" | "amber" | "red" | "neutral" =
    missing === sources.length
      ? "neutral"
      : ageHours === null
        ? "neutral"
        : ageHours > 24
          ? "red"
          : ageHours > 6
            ? "amber"
            : "green";

  const title = sources
    .map((s) => `${s.label}: ${relativeTime(s.at) ?? "no data"}`)
    .join("\n");

  const label =
    oldestRel === null
      ? "no data"
      : missing > 0
        ? `${oldestRel} · ${missing} missing`
        : `${oldestRel}`;

  return (
    <Badge tone={tone} className="cursor-help" >
      <span title={title} className="inline-flex items-center gap-1">
        <Icon.Refresh width={11} height={11} />
        Data {label}
      </span>
    </Badge>
  );
}

function WatchlistRow({
  entry,
  stock,
  analysis,
  request,
  submitting,
  mode,
  onModeChange,
  onRun,
  onRemove,
}: {
  entry: WatchlistEntry;
  stock: StockRow | undefined;
  analysis: Analysis | undefined;
  request: AnalysisRequest | undefined;
  submitting: boolean;
  mode: AnalysisMode;
  onModeChange: (mode: AnalysisMode) => void;
  onRun: () => void;
  onRemove: () => void;
}) {
  const finviz = readFinviz(stock?.finviz);
  const optioncharts = readOptioncharts(stock?.optioncharts);
  const price = stock ? readPrice(stock) : null;
  const inFlight =
    submitting || request?.status === "pending" || request?.status === "running";
  const showRequestStatus =
    request &&
    (request.status === "pending" ||
      request.status === "running" ||
      request.status === "error");

  // Premium-vs-intrinsic delta hint (e.g., "+8% vs intrinsic" or "-12%").
  const intrinsic = stock?.intrinsic_value ?? null;
  const deltaPct =
    price !== null && intrinsic !== null && intrinsic !== 0
      ? ((price - intrinsic) / intrinsic) * 100
      : null;
  const deltaTone: "positive" | "negative" | "muted" =
    deltaPct === null ? "muted" : deltaPct >= 0 ? "negative" : "positive";

  return (
    <div className="rounded-xl border border-neutral-200/80 bg-white/60 p-4 transition-colors hover:border-neutral-300 hover:bg-white dark:border-neutral-800 dark:bg-neutral-900/40 dark:hover:border-neutral-700 dark:hover:bg-neutral-900">
      {/* Top row: identity + freshness + remove */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold tracking-tight">{entry.symbol}</span>
          {finviz.sector && (
            <span className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              {finviz.sector}
            </span>
          )}
          <FreshnessPill stock={stock} />
        </div>
        <IconButton
          label={`Remove ${entry.symbol}`}
          onClick={onRemove}
          className="hover:!text-red-500"
        >
          <Icon.X />
        </IconButton>
      </div>

      {/* Metrics */}
      <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-7">
        <Stat label="Price" value={formatCurrency(price)} />
        <Stat
          label="Intrinsic"
          value={formatCurrency(intrinsic)}
          hint={
            deltaPct !== null
              ? `${deltaPct >= 0 ? "+" : ""}${formatNumber(deltaPct, 1)}%`
              : undefined
          }
          tone={deltaTone}
        />
        <Stat label="IV Rank" value={formatPercent(optioncharts.ivRank)} />
        <Stat label="Beta" value={formatNumber(finviz.beta)} />
        <Stat label="Short %" value={formatPercent(finviz.shortFloat)} />
        <Stat label="RSI" value={formatNumber(finviz.rsi14)} />
        <Stat label="Earnings" value={formatDate(finviz.earningsDate)} />
      </div>

      {/* Action row */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3 dark:border-neutral-800">
        <SegmentedControl
          value={mode}
          onChange={onModeChange}
          options={MODE_OPTIONS}
        />
        <Button onClick={onRun} disabled={inFlight} tone="primary" size="sm">
          {inFlight ? "Running…" : "Run analysis"}
        </Button>
        <Button
          onClick={() => window.open(IBKR_POSITIONS_URL, "_blank")}
          tone="success"
          size="sm"
        >
          Buy <Icon.External width={12} height={12} />
        </Button>
        {showRequestStatus && (
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <StatusBadge status={request.status} />
            <span>{relativeTime(request.requested_at) ?? ""}</span>
            {request.error && (
              <span className="text-red-500" title={request.error}>
                · {request.error}
              </span>
            )}
          </div>
        )}
        {analysis && <AnalysisResult analysis={analysis} />}
      </div>
    </div>
  );
}

function AnalysisResult({ analysis }: { analysis: Analysis }) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
      {analysis.verdict && (
        <Badge tone={analysis.verdict === "PASS" ? "green" : "red"}>
          {analysis.verdict}
        </Badge>
      )}
      {analysis.score_total != null && (
        <span className="num text-neutral-500">
          {analysis.score_pass ?? 0}/{analysis.score_total}
        </span>
      )}
      {analysis.recommended_strike != null && (
        <span className="num text-neutral-500">
          {formatCurrency(analysis.recommended_strike)}
          {analysis.recommended_expiry
            ? ` · ${formatDate(analysis.recommended_expiry)}`
            : ""}
        </span>
      )}
      {analysis.decision && <Badge tone="brand">{analysis.decision}</Badge>}
      {analysis.why && (
        <span
          className="max-w-xs truncate text-xs text-neutral-500"
          title={analysis.why}
        >
          {analysis.why}
        </span>
      )}
    </div>
  );
}
