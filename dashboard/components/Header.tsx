"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import DiagnosticsPanel from "@/components/DiagnosticsPanel";
import { Icon } from "@/components/lib/ui";

function initialsFor(email: string | null): string {
  if (!email) return "?";
  const local = email.split("@")[0] ?? email;
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (local[0] + (local[1] ?? "")).toUpperCase();
}

export default function Header({ email }: { email: string | null }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 -mx-4 border-b border-neutral-200/70 bg-white/70 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6 dark:border-neutral-800/70 dark:bg-neutral-950/70">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-md shadow-brand-500/30">
            <Icon.Logo width={18} height={18} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight tracking-tight">
              OptionPilot
            </h1>
            <p className="truncate text-[11px] text-neutral-500">
              Cash-secured put cockpit
            </p>
          </div>
        </div>

        {email ? (
          <details className="relative">
            <summary
              className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-neutral-200 bg-white py-1 pl-1 pr-2.5 text-sm transition-colors hover:bg-neutral-100 [&::-webkit-details-marker]:hidden dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800"
              aria-label="Account menu"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-[11px] font-semibold text-white">
                {initialsFor(email)}
              </span>
              <span className="hidden max-w-[160px] truncate text-neutral-600 sm:inline dark:text-neutral-300">
                {email}
              </span>
              <Icon.ChevronDown
                width={14}
                height={14}
                className="text-neutral-400"
              />
            </summary>
            <div className="absolute right-0 mt-2 w-64 origin-top-right animate-fade-in rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
              <div className="border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
                <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                  Signed in as
                </p>
                <p className="truncate text-sm text-neutral-800 dark:text-neutral-100">
                  {email}
                </p>
              </div>
              <div className="px-1 py-1">
                <DiagnosticsPanel email={email} />
              </div>
              <button
                type="button"
                onClick={signOut}
                disabled={signingOut}
                className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <span>{signingOut ? "Signing out…" : "Sign out"}</span>
                <Icon.External width={14} height={14} className="text-neutral-400" />
              </button>
            </div>
          </details>
        ) : null}
      </div>
    </header>
  );
}
