// Typed browser client wrapper.
//
// The shared `@optionpilot/contracts` Database type declares the empty
// `Views`/`Functions`/`Enums`/`CompositeTypes` namespaces as
// `Record<string, never>`. That carries a `string` index signature, and under
// @supabase/postgrest-js >= 2.106 the internal `Tables & Views` intersection
// collapses every table Row to `never` (breaking all query/insert typing).
//
// We re-cast the browser client to an equivalent schema whose empty namespaces
// are index-signature-free (`Record<never, never>`), matching the
// supabase-codegen convention. The runtime client is identical; only the static
// types are corrected.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@optionpilot/contracts";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";

type EmptyNamespace = Record<never, never>;

type FixedPublic = Omit<
  Database["public"],
  "Views" | "Functions" | "Enums" | "CompositeTypes"
> & {
  Views: EmptyNamespace;
  Functions: EmptyNamespace;
  Enums: EmptyNamespace;
  CompositeTypes: EmptyNamespace;
};

export type DB = Omit<Database, "public"> & { public: FixedPublic };

export type TypedClient = SupabaseClient<DB>;

export function createClient(): TypedClient {
  return createBrowserSupabase() as unknown as TypedClient;
}
