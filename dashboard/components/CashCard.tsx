"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Database } from "@optionpilot/contracts";
import { createClient } from "./lib/db";
import { Button, Card, Icon, IconButton, Skeleton } from "./lib/ui";
import { formatCurrency, relativeTime, useNow } from "./lib/format";

type Profile = Database["public"]["Tables"]["profiles"]["Row"];

export default function CashCard({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useNow(60_000);

  const applyProfile = useCallback((p: Profile) => {
    setProfile(p);
  }, []);

  useEffect(() => {
    let active = true;
    void supabase
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!active) return;
        if (data) applyProfile(data);
        setLoading(false);
      });

    const channel = supabase
      .channel("profiles-cash")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "profiles", filter: `user_id=eq.${userId}` },
        (payload) => {
          if (payload.new && "user_id" in payload.new) {
            setProfile(payload.new as Profile);
          }
        },
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [supabase, userId, applyProfile]);

  function startEditing() {
    setDraft(profile?.total_account_value === null || profile?.total_account_value === undefined
      ? ""
      : String(profile.total_account_value));
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setDraft("");
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const trimmed = draft.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && !Number.isFinite(value)) {
      setSaving(false);
      setError("Please enter a valid number.");
      return;
    }
    const { data, error: upsertError } = await supabase
      .from("profiles")
      .upsert(
        { user_id: userId, total_account_value: value },
        { onConflict: "user_id" },
      )
      .select()
      .single();
    setSaving(false);
    if (upsertError) {
      setError(upsertError.message);
      return;
    }
    if (data) {
      setProfile(data);
      setEditing(false);
    }
  }

  return (
    <Card
      title="Account"
      actions={
        profile && !editing ? (
          <span className="text-[11px] text-neutral-400">
            updated {relativeTime(profile.updated_at) ?? "—"}
          </span>
        ) : null
      }
    >
      {loading ? (
        <div className="flex items-end justify-between gap-4">
          <div>
            <Skeleton className="mb-2 h-3 w-32" />
            <Skeleton className="h-9 w-44" />
          </div>
        </div>
      ) : editing ? (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-neutral-500">
              Total account value
            </span>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-neutral-400">
                $
              </span>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                  if (e.key === "Escape") cancelEditing();
                }}
                placeholder="0.00"
                className="w-full rounded-md border border-neutral-300 bg-white py-2 pl-7 pr-3 text-base focus:border-brand-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900"
              />
            </div>
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={saving} tone="primary">
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button onClick={cancelEditing} tone="secondary" disabled={saving}>
              Cancel
            </Button>
          </div>
          <p className="text-[11px] text-neutral-400">
            Press <kbd className="rounded border border-neutral-200 px-1 dark:border-neutral-700">Enter</kbd> to save · <kbd className="rounded border border-neutral-200 px-1 dark:border-neutral-700">Esc</kbd> to cancel
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-neutral-500">
              Total account value
            </p>
            <p className="num mt-1 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              {profile?.total_account_value != null ? (
                formatCurrency(profile.total_account_value)
              ) : (
                <span className="text-neutral-400">Not set</span>
              )}
            </p>
          </div>
          <IconButton label="Edit account value" onClick={startEditing}>
            <Icon.Edit />
          </IconButton>
        </div>
      )}
    </Card>
  );
}
