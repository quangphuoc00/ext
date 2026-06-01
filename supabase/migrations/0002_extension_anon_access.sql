-- 0002_extension_anon_access.sql  (OptionPilot)
-- The admin scraper extension runs in a browser (MV3 service worker) with no
-- sign-in. Supabase forbids using a secret/service-role key from a browser, so
-- the extension must use the public (anon) key. To let it (a) discover every
-- user's tracked symbols and (b) persist scraped market data, we:
--   1. expose a SECURITY DEFINER function that returns ONLY the deduplicated
--      symbol list (no per-user rows leak), callable by anon;
--   2. allow anon read/write on the shared, objective market-data tables.
-- Personal tables (watchlist, portfolio, profiles, analyses, *_requests) keep
-- their owner-only RLS untouched.

-- ============================================================================
-- 1. Distinct symbols across ALL users' watchlist + portfolio.
--    SECURITY DEFINER bypasses RLS but returns only the symbol set, so no
--    ownership / holdings information is exposed to the caller.
-- ============================================================================
create or replace function public.all_tracked_symbols()
returns table (symbol text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct upper(trim(s.symbol)) as symbol
  from (
    select symbol from public.watchlist
    union all
    select symbol from public.portfolio
  ) s
  where s.symbol is not null and length(trim(s.symbol)) > 0
$$;

revoke all on function public.all_tracked_symbols() from public;
grant execute on function public.all_tracked_symbols() to anon, authenticated;

-- ============================================================================
-- 2. Shared market-data tables: allow the anon role (the extension's public
--    key) to read and upsert. These tables hold objective, non-personal data.
-- ============================================================================
drop policy if exists anon_read_stocks on public.stocks;
create policy anon_read_stocks on public.stocks for select to anon using (true);
drop policy if exists anon_insert_stocks on public.stocks;
create policy anon_insert_stocks on public.stocks for insert to anon with check (true);
drop policy if exists anon_update_stocks on public.stocks;
create policy anon_update_stocks on public.stocks for update to anon using (true) with check (true);

drop policy if exists anon_read_macro on public.macro_data;
create policy anon_read_macro on public.macro_data for select to anon using (true);
drop policy if exists anon_insert_macro on public.macro_data;
create policy anon_insert_macro on public.macro_data for insert to anon with check (true);
drop policy if exists anon_update_macro on public.macro_data;
create policy anon_update_macro on public.macro_data for update to anon using (true) with check (true);
