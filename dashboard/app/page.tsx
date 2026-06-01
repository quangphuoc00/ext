import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import MacroBar from "@/components/MacroBar";
import CashCard from "@/components/CashCard";
import Watchlist from "@/components/Watchlist";
import Portfolio from "@/components/Portfolio";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="min-h-screen">
      <Header email={user?.email ?? null} />
      <main className="mx-auto max-w-6xl space-y-5 px-4 pb-12 pt-4 sm:px-6 sm:pt-5">
        {user ? (
          <>
            <MacroBar />
            <CashCard userId={user.id} />
            <Watchlist />
            <Portfolio />
          </>
        ) : (
          <div className="mx-auto mt-12 max-w-md rounded-2xl border border-neutral-200 bg-white p-8 text-center shadow-card dark:border-neutral-800 dark:bg-neutral-900">
            <h2 className="text-lg font-semibold">Sign in required</h2>
            <p className="mt-1 text-sm text-neutral-500">
              You must be signed in to view the cockpit.
            </p>
            <a
              href="/login"
              className="mt-4 inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-500"
            >
              Go to sign in
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
