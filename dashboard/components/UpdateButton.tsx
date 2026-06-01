"use client";

import { useEffect, useMemo, useState } from "react";
import type { Database } from "@optionpilot/contracts";
import { createClient } from "./lib/db";
import { StatusBadge } from "./lib/ui";
import { formatDateTime } from "./lib/format";

type ScrapeRequest = Database["public"]["Tables"]["scrape_requests"]["Row"];

export default function UpdateButton() {
  const supabase = useMemo(() => createClient(), []);
  const [latest, setLatest] = useState<ScrapeRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void supabase
      .from("scrape_requests")
      .select("*")
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) setLatest(data);
      });

    const channel = supabase
      .channel("scrape-requests")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "scrape_requests" },
        (payload) => {
          const row = payload.new;
          if (!row || !("id" in row)) return;
          const next = row as ScrapeRequest;
          setLatest((prev) =>
            !prev || new Date(next.requested_at) >= new Date(prev.requested_at)
              ? next
              : prev,
          );
        },
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [supabase]);

  async function requestUpdate() {
    setSubmitting(true);
    setError(null);
    const { data, error: insertError } = await supabase
      .from("scrape_requests")
      .insert({})
      .select()
      .single();
    setSubmitting(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    if (data) setLatest(data);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={requestUpdate}
        disabled={submitting}
        className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {submitting ? "Requesting…" : "Update data"}
      </button>
      {latest ? (
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <StatusBadge status={latest.status} />
          <span>{formatDateTime(latest.requested_at)}</span>
          {latest.error && (
            <span className="text-red-500" title={latest.error}>
              · {latest.error}
            </span>
          )}
        </div>
      ) : (
        <span className="text-sm text-neutral-400">No scrape requests yet</span>
      )}
      {error && <span className="text-sm text-red-500">{error}</span>}
    </div>
  );
}
