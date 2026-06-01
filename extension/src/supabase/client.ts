// Owner: Agent A (extension engine). Supabase client for the admin-only
// extension. Runs in a browser (MV3 service worker) with no sign-in, so it uses
// the public (anon/publishable) key. Reading every user's symbols and writing
// shared market data is enabled on the backend via the all_tracked_symbols()
// SECURITY DEFINER function and anon policies (see migration 0002). A
// secret/service-role key cannot be used here: Supabase forbids secret keys
// from a browser context.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@optionpilot/contracts";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

let client: SupabaseClient<Database> | null = null;

export function getSupabase(): SupabaseClient<Database> {
  if (!client) {
    client = createClient<Database>(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}
