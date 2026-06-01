-- 0002_watchlist_realtime.sql  (OptionPilot)
-- Stream watchlist add/remove over Realtime so the dashboard never needs a refresh.
alter publication supabase_realtime add table public.watchlist;
