"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@optionpilot/contracts";

type BrowserClient = ReturnType<typeof createBrowserClient<Database>>;

let client: BrowserClient | undefined;

export function createClient(): BrowserClient {
  if (client) return client;

  client = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  // supabase-js only pushes the user's access token to the Realtime socket on
  // SIGNED_IN / TOKEN_REFRESHED — not on INITIAL_SESSION (what fires when the
  // session is restored from cookies on a page reload). Without the user token,
  // Realtime evaluates RLS with no auth.uid(), so owner-scoped subscriptions
  // (watchlist, analyses, analysis_requests) silently receive no events while
  // public tables (stocks, macro_data) still stream. Apply it explicitly here
  // and keep it in sync so RLS-scoped Realtime is reliable after a reload.
  const realtimeClient = client;
  void realtimeClient.auth.getSession().then(({ data }) => {
    realtimeClient.realtime.setAuth(data.session?.access_token);
  });
  realtimeClient.auth.onAuthStateChange((_event, session) => {
    realtimeClient.realtime.setAuth(session?.access_token);
  });

  return client;
}
