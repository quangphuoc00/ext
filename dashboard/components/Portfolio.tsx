"use client";

import { useEffect, useMemo, useState } from "react";
import type { Database, PortfolioStatus } from "@optionpilot/contracts";
import { createClient } from "./lib/db";
import {
  Badge,
  Button,
  Card,
  Dot,
  Icon,
  IconButton,
  SegmentedControl,
  Skeleton,
} from "./lib/ui";
import {
  daysUntil,
  formatCurrency,
  formatDate,
  isPastDate,
  useNow,
} from "./lib/format";
import { findPutMid, type StockRow } from "./lib/stocks";

type Position = Database["public"]["Tables"]["portfolio"]["Row"];

const IBKR_POSITIONS_URL =
  "https://portal.interactivebrokers.com/portal/?loginType=1&action=ACCT_MGMT_MAIN&RL=1&locale=en_US#/dashboard/positions";

const STATUSES: PortfolioStatus[] = ["open", "closed", "assigned", "expired"];

const statusTone: Record<PortfolioStatus, "green" | "neutral" | "amber" | "red"> = {
  open: "green",
  closed: "neutral",
  assigned: "amber",
  expired: "red",
};

type FormState = {
  symbol: string;
  strike: string;
  expiry: string;
  contracts: string;
  premium_received: string;
  status: PortfolioStatus;
};

const EMPTY_FORM: FormState = {
  symbol: "",
  strike: "",
  expiry: "",
  contracts: "1",
  premium_received: "",
  status: "open",
};

function toForm(p: Position): FormState {
  return {
    symbol: p.symbol,
    strike: String(p.strike),
    expiry: p.expiry,
    contracts: String(p.contracts),
    premium_received: String(p.premium_received),
    status: p.status,
  };
}

type PositionView = {
  position: Position;
  collateral: number;
  dte: number | null;
  currentMid: number | null;
  pnl: number | null;
  expired: boolean;
};

function viewOf(position: Position, stocks: Record<string, StockRow>): PositionView {
  const stock = stocks[position.symbol];
  const collateral = position.strike * 100 * position.contracts;
  const dte = daysUntil(position.expiry);
  const currentMid = stock
    ? findPutMid(stock.yahoo_options, position.expiry, position.strike)
    : null;
  const pnl =
    currentMid !== null
      ? (position.premium_received - currentMid) * 100 * position.contracts
      : null;
  const expired = isPastDate(position.expiry);
  return { position, collateral, dte, currentMid, pnl, expired };
}

type StatusFilter = "all" | "open";

export default function Portfolio() {
  const supabase = useMemo(() => createClient(), []);
  const [positions, setPositions] = useState<Position[]>([]);
  const [stocks, setStocks] = useState<Record<string, StockRow>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  useNow(60_000);

  async function loadStocks(symbols: string[]) {
    const unique = Array.from(new Set(symbols));
    if (unique.length === 0) return;
    const { data } = await supabase.from("stocks").select("*").in("symbol", unique);
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
    async function init() {
      const { data } = await supabase
        .from("portfolio")
        .select("*")
        .order("expiry", { ascending: true });
      if (!active) return;
      const rows = data ?? [];
      setPositions(rows);
      await loadStocks(rows.map((r) => r.symbol));
      if (active) setLoading(false);
    }
    void init();

    const channel = supabase
      .channel("portfolio-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "portfolio" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const old = payload.old;
            if (old && "id" in old) {
              const id = (old as Position).id;
              setPositions((prev) => prev.filter((p) => p.id !== id));
            }
            return;
          }
          const row = payload.new;
          if (!row || !("id" in row)) return;
          const position = row as Position;
          setPositions((prev) => {
            const idx = prev.findIndex((p) => p.id === position.id);
            if (idx === -1) return [...prev, position];
            const next = [...prev];
            next[idx] = position;
            return next;
          });
          void loadStocks([position.symbol]);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "stocks" },
        (payload) => {
          const row = payload.new;
          if (!row || !("symbol" in row)) return;
          const stock = row as StockRow;
          setStocks((prev) =>
            prev[stock.symbol] ? { ...prev, [stock.symbol]: stock } : prev,
          );
        },
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [supabase]);

  async function savePosition(form: FormState, id: string | null) {
    setError(null);
    const strike = Number(form.strike);
    const contracts = Number(form.contracts);
    const premium = Number(form.premium_received);
    const symbol = form.symbol.trim().toUpperCase();
    if (!symbol || !form.expiry) {
      setError("Symbol and expiry are required.");
      return;
    }
    if (![strike, contracts, premium].every(Number.isFinite) || contracts <= 0) {
      setError("Enter valid strike, contracts (>0), and premium.");
      return;
    }
    const payload = {
      symbol,
      strike,
      expiry: form.expiry,
      contracts: Math.round(contracts),
      premium_received: premium,
      status: form.status,
    };
    if (id) {
      const { error: updError } = await supabase
        .from("portfolio")
        .update(payload)
        .eq("id", id);
      if (updError) {
        setError(updError.message);
        return;
      }
      setEditingId(null);
    } else {
      const { data, error: insError } = await supabase
        .from("portfolio")
        .insert(payload)
        .select()
        .single();
      if (insError) {
        setError(insError.message);
        return;
      }
      if (data) {
        setPositions((prev) =>
          prev.some((p) => p.id === data.id) ? prev : [...prev, data],
        );
      }
      setAdding(false);
    }
    await loadStocks([symbol]);
  }

  async function closePosition(id: string) {
    const { error: updError } = await supabase
      .from("portfolio")
      .update({ status: "closed" })
      .eq("id", id);
    if (updError) setError(updError.message);
  }

  const views = useMemo(
    () => positions.map((p) => viewOf(p, stocks)),
    [positions, stocks],
  );
  const visibleViews = useMemo(
    () =>
      filter === "open" ? views.filter((v) => v.position.status === "open") : views,
    [views, filter],
  );

  // Summary statistics computed across visible rows.
  const summary = useMemo(() => {
    const openOnly = views.filter((v) => v.position.status === "open");
    const totalCollateral = openOnly.reduce((s, v) => s + v.collateral, 0);
    const knownPnl = openOnly.filter((v) => v.pnl !== null);
    const totalUnrealized = knownPnl.reduce((s, v) => s + (v.pnl ?? 0), 0);
    const atRisk = openOnly.filter((v) => v.expired).length;
    return {
      openCount: openOnly.length,
      totalCount: views.length,
      totalCollateral,
      totalUnrealized,
      pnlKnown: knownPnl.length === openOnly.length && openOnly.length > 0,
      atRisk,
    };
  }, [views]);

  return (
    <Card
      title="Portfolio"
      subtitle={
        positions.length > 0
          ? `${summary.openCount} open · ${summary.totalCount} total${
              summary.atRisk > 0 ? ` · ${summary.atRisk} expired open` : ""
            }`
          : undefined
      }
      actions={
        <>
          {positions.length > 0 && (
            <SegmentedControl
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "open", label: "Open" },
              ]}
            />
          )}
          <Button
            onClick={() => {
              setAdding((v) => !v);
              setEditingId(null);
            }}
            tone={adding ? "secondary" : "primary"}
            size="sm"
          >
            {adding ? "Cancel" : (
              <>
                <Icon.Plus width={14} height={14} /> Add position
              </>
            )}
          </Button>
        </>
      }
    >
      {error && (
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {!loading && summary.openCount > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <SummaryStat label="Open positions" value={String(summary.openCount)} />
          <SummaryStat
            label="Collateral"
            value={formatCurrency(summary.totalCollateral)}
          />
          <SummaryStat
            label="Unrealized P&L"
            value={formatCurrency(summary.totalUnrealized)}
            tone={
              summary.totalUnrealized >= 0 ? "positive" : "negative"
            }
            hint={summary.pnlKnown ? undefined : "partial pricing"}
          />
        </div>
      )}

      {adding && (
        <div className="mb-4">
          <PositionForm
            initial={EMPTY_FORM}
            onSubmit={(form) => savePosition(form, null)}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : positions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-200 px-6 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800">
          No positions yet. Click <span className="font-medium">Add position</span> to record a sold put.
        </div>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:border-neutral-800">
                <th className="px-2 py-2.5">Symbol</th>
                <th className="px-2 py-2.5 text-right">Strike</th>
                <th className="px-2 py-2.5">Expiry</th>
                <th className="px-2 py-2.5 text-right">Qty</th>
                <th className="px-2 py-2.5 text-right">Premium</th>
                <th className="px-2 py-2.5 text-right">Collateral</th>
                <th className="px-2 py-2.5 text-right">DTE</th>
                <th className="px-2 py-2.5 text-right">Unreal. P&L</th>
                <th className="px-2 py-2.5">Status</th>
                <th className="px-2 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleViews.map((view) =>
                editingId === view.position.id ? (
                  <tr key={view.position.id}>
                    <td colSpan={10} className="py-2">
                      <PositionForm
                        initial={toForm(view.position)}
                        onSubmit={(form) => savePosition(form, view.position.id)}
                        onCancel={() => setEditingId(null)}
                      />
                    </td>
                  </tr>
                ) : (
                  <PositionRow
                    key={view.position.id}
                    view={view}
                    onEdit={() => {
                      setEditingId(view.position.id);
                      setAdding(false);
                    }}
                    onClose={() => closePosition(view.position.id)}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SummaryStat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
  hint?: string;
}) {
  const valueClass =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "negative"
        ? "text-red-600 dark:text-red-400"
        : "text-neutral-900 dark:text-neutral-50";
  return (
    <div className="rounded-lg border border-neutral-200/70 bg-neutral-50/60 px-3 py-2.5 dark:border-neutral-800/70 dark:bg-neutral-900/40">
      <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={`num mt-0.5 text-base font-semibold ${valueClass}`}>{value}</div>
      {hint && <div className="text-[10px] text-neutral-400">{hint}</div>}
    </div>
  );
}

function PositionRow({
  view,
  onEdit,
  onClose,
}: {
  view: PositionView;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { position, collateral, dte, pnl, expired } = view;
  const atRisk = expired && position.status === "open";

  return (
    <tr
      className={`group border-b border-neutral-100 transition-colors hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-800/40 ${
        atRisk ? "bg-amber-50/40 dark:bg-amber-950/10" : ""
      }`}
    >
      <td className="px-2 py-2.5 font-semibold tracking-tight">{position.symbol}</td>
      <td className="num px-2 py-2.5 text-right">{formatCurrency(position.strike)}</td>
      <td className="px-2 py-2.5">
        <span className={expired ? "text-red-500" : undefined}>
          {formatDate(position.expiry)}
        </span>
      </td>
      <td className="num px-2 py-2.5 text-right">{position.contracts}</td>
      <td className="num px-2 py-2.5 text-right">
        {formatCurrency(position.premium_received)}
      </td>
      <td className="num px-2 py-2.5 text-right">{formatCurrency(collateral)}</td>
      <td className="num px-2 py-2.5 text-right">
        {dte === null ? (
          "—"
        ) : expired ? (
          <span className="font-medium text-red-500">{dte}</span>
        ) : dte <= 7 ? (
          <span className="font-medium text-amber-600 dark:text-amber-400">{dte}</span>
        ) : (
          dte
        )}
      </td>
      <td
        className={`num px-2 py-2.5 text-right ${
          pnl === null
            ? "text-neutral-400"
            : pnl >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
        }`}
      >
        {pnl === null ? "—" : formatCurrency(pnl)}
      </td>
      <td className="px-2 py-2.5">
        <Badge tone={atRisk ? "amber" : statusTone[position.status]}>
          <Dot tone={atRisk ? "amber" : statusTone[position.status]} />
          {atRisk ? "expired?" : position.status}
        </Badge>
      </td>
      <td className="px-2 py-2.5">
        <div className="flex items-center justify-end gap-1">
          <Button
            onClick={() => window.open(IBKR_POSITIONS_URL, "_blank")}
            tone="danger"
            size="sm"
          >
            Sell <Icon.External width={11} height={11} />
          </Button>
          <IconButton label="Edit position" onClick={onEdit}>
            <Icon.Edit />
          </IconButton>
          {position.status === "open" && (
            <IconButton
              label="Mark closed"
              onClick={onClose}
              className="hover:!text-red-500"
            >
              <Icon.Trash />
            </IconButton>
          )}
        </div>
      </td>
    </tr>
  );
}

function PositionForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: FormState;
  onSubmit: (form: FormState) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
      className="grid grid-cols-2 gap-3 rounded-lg border border-neutral-200 bg-neutral-50/50 p-3 sm:grid-cols-7 sm:items-end dark:border-neutral-800 dark:bg-neutral-900/40"
    >
      <Input
        label="Symbol"
        value={form.symbol}
        onChange={(v) => set("symbol", v.toUpperCase())}
      />
      <Input
        label="Strike"
        type="number"
        value={form.strike}
        onChange={(v) => set("strike", v)}
      />
      <Input
        label="Expiry"
        type="date"
        value={form.expiry}
        onChange={(v) => set("expiry", v)}
      />
      <Input
        label="Contracts"
        type="number"
        value={form.contracts}
        onChange={(v) => set("contracts", v)}
      />
      <Input
        label="Premium"
        type="number"
        value={form.premium_received}
        onChange={(v) => set("premium_received", v)}
      />
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-neutral-500">
          Status
        </span>
        <select
          value={form.status}
          onChange={(e) => set("status", e.target.value as PortfolioStatus)}
          className="w-full rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm focus:border-brand-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <div className="col-span-2 flex gap-2 sm:col-span-1">
        <Button type="submit" tone="primary">
          Save
        </Button>
        <Button type="button" tone="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-neutral-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm focus:border-brand-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900"
      />
    </label>
  );
}
