-- 0001_init.sql  (OptionPilot)
-- Postgres / Supabase. Shared objective data is global; personal data is RLS-scoped to the user.

-- Helper: auto-maintain updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

-- ============================================================================
-- PERSONAL: per-user profile (replaces separate cash + settings tables)
-- ============================================================================
create table if not exists public.profiles (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  cash               numeric(14,2) not null default 0,
  total_account_value numeric(14,2),         -- used by the CSP sizing checklist
  stagger_delay_ms   integer not null default 15000,
  poll_interval_ms   integer not null default 60000,
  stable_close_count integer not null default 10,
  updated_at         timestamptz not null default now()
);

-- Auto-create a profile row when a user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ============================================================================
-- SHARED: market data (one row per symbol; objective; same for everyone)
-- Merges the old intrinsic_values + scraped_data into one row per symbol.
-- ============================================================================
create table if not exists public.stocks (
  symbol                     text primary key,
  intrinsic_value            numeric(14,4),
  intrinsic_updated_at       timestamptz,
  yahoo_options              jsonb,
  yahoo_options_updated_at   timestamptz,
  optioncharts               jsonb,
  optioncharts_updated_at    timestamptz,
  yahoo_analysis             jsonb,
  yahoo_analysis_updated_at  timestamptz,
  finviz                     jsonb,
  finviz_updated_at          timestamptz,
  updated_at                 timestamptz not null default now()
);

-- ============================================================================
-- SHARED: macro data (one row per metric; objective)
-- metrics: t10y2y | hy_oas | vix | spy_sma200
-- ============================================================================
create table if not exists public.macro_data (
  metric     text primary key,
  value      numeric(14,4),
  as_of      date,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- PERSONAL: watchlist
-- ============================================================================
create table if not exists public.watchlist (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  symbol     text not null,
  created_at timestamptz not null default now(),
  unique (user_id, symbol)
);

-- ============================================================================
-- PERSONAL: portfolio (sold cash-secured puts)
-- premium_received is per-share; collateral = strike * 100 * contracts
-- ============================================================================
create table if not exists public.portfolio (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade default auth.uid(),
  symbol           text not null,
  strike           numeric(14,4) not null,
  expiry           date not null,
  contracts        integer not null check (contracts > 0),
  premium_received numeric(14,4) not null,
  opened_at        timestamptz not null default now(),
  status           text not null default 'open'
                     check (status in ('open','closed','assigned','expired')),
  updated_at       timestamptz not null default now()
);

-- ============================================================================
-- PERSONAL: analysis results
-- ============================================================================
create table if not exists public.analyses (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade default auth.uid(),
  symbol             text not null,
  mode               text check (mode in ('routine','dip_buy')),
  verdict            text check (verdict in ('PASS','FAIL')),
  score_pass         integer,
  score_total        integer,
  recommended_strike numeric(14,4),
  recommended_expiry date,
  why                text,
  decision           text,
  raw_response       text,
  created_at         timestamptz not null default now()
);

-- ============================================================================
-- PERSONAL: scrape job queue (dashboard "Update" inserts -> extension consumes via Realtime)
-- ============================================================================
create table if not exists public.scrape_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade default auth.uid(),
  status       text not null default 'pending'
                 check (status in ('pending','running','done','error')),
  error        text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

-- ============================================================================
-- PERSONAL: analysis job queue (dashboard inserts -> extension consumes via Realtime)
-- ============================================================================
create table if not exists public.analysis_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade default auth.uid(),
  symbol       text not null,
  mode         text check (mode in ('routine','dip_buy')),
  status       text not null default 'pending'
                 check (status in ('pending','running','done','error')),
  error        text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

-- ============================================================================
-- updated_at triggers
-- ============================================================================
drop trigger if exists trg_profiles_upd  on public.profiles;
create trigger trg_profiles_upd  before update on public.profiles  for each row execute function public.set_updated_at();
drop trigger if exists trg_stocks_upd    on public.stocks;
create trigger trg_stocks_upd    before update on public.stocks    for each row execute function public.set_updated_at();
drop trigger if exists trg_macro_upd     on public.macro_data;
create trigger trg_macro_upd     before update on public.macro_data for each row execute function public.set_updated_at();
drop trigger if exists trg_portfolio_upd on public.portfolio;
create trigger trg_portfolio_upd before update on public.portfolio for each row execute function public.set_updated_at();

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.profiles          enable row level security;
alter table public.stocks            enable row level security;
alter table public.macro_data        enable row level security;
alter table public.watchlist         enable row level security;
alter table public.portfolio         enable row level security;
alter table public.analyses          enable row level security;
alter table public.analysis_requests enable row level security;
alter table public.scrape_requests   enable row level security;

-- Personal tables: owner-only
drop policy if exists own_profile on public.profiles;
create policy own_profile on public.profiles
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_watch on public.watchlist;
create policy own_watch on public.watchlist
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_port on public.portfolio;
create policy own_port on public.portfolio
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_analyses on public.analyses;
create policy own_analyses on public.analyses
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_reqs on public.analysis_requests;
create policy own_reqs on public.analysis_requests
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_screqs on public.scrape_requests;
create policy own_screqs on public.scrape_requests
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Shared tables: any authenticated user can read + upsert (objective data)
drop policy if exists read_stocks on public.stocks;
create policy read_stocks on public.stocks for select to authenticated using (true);
drop policy if exists write_stocks on public.stocks;
create policy write_stocks on public.stocks for insert to authenticated with check (true);
drop policy if exists update_stocks on public.stocks;
create policy update_stocks on public.stocks for update to authenticated using (true) with check (true);

drop policy if exists read_macro on public.macro_data;
create policy read_macro on public.macro_data for select to authenticated using (true);
drop policy if exists write_macro on public.macro_data;
create policy write_macro on public.macro_data for insert to authenticated with check (true);
drop policy if exists update_macro on public.macro_data;
create policy update_macro on public.macro_data for update to authenticated using (true) with check (true);

-- ============================================================================
-- Realtime
-- ============================================================================
alter publication supabase_realtime add table public.stocks;
alter publication supabase_realtime add table public.macro_data;
alter publication supabase_realtime add table public.analyses;
alter publication supabase_realtime add table public.analysis_requests;
alter publication supabase_realtime add table public.scrape_requests;
alter publication supabase_realtime add table public.portfolio;
alter publication supabase_realtime add table public.profiles;
