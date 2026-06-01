-- 0004_anon_request_worker_access.sql  (OptionPilot)
-- The extension's analysis worker and scrape orchestrator both run in a browser
-- (MV3 service worker) with no sign-in, using the public (anon) key. Because
-- *_requests tables have RLS enabled with owner-only policies (requiring
-- auth.uid() = user_id), the anon extension client can:
--   - see 0 rows when polling for pending requests (SELECT filtered silently)
--   - receive no Realtime postgres_changes events (Supabase evaluates RLS
--     before delivering events; auth.uid() is null -> all rows filtered)
--
-- Fix: grant anon SELECT + UPDATE on both request tables so the workers can
-- discover and claim pending rows and so Realtime delivers INSERT events.
-- INSERT is intentionally excluded: only the dashboard (authenticated users)
-- should create request rows.

-- ============================================================================
-- analysis_requests: read + update for the analysis worker (anon key)
-- ============================================================================
drop policy if exists anon_read_analysis_reqs on public.analysis_requests;
create policy anon_read_analysis_reqs on public.analysis_requests
  for select to anon using (true);

drop policy if exists anon_update_analysis_reqs on public.analysis_requests;
create policy anon_update_analysis_reqs on public.analysis_requests
  for update to anon using (true) with check (true);

-- ============================================================================
-- scrape_requests: read + update for the scrape orchestrator (anon key)
-- ============================================================================
drop policy if exists anon_read_scrape_reqs on public.scrape_requests;
create policy anon_read_scrape_reqs on public.scrape_requests
  for select to anon using (true);

drop policy if exists anon_update_scrape_reqs on public.scrape_requests;
create policy anon_update_scrape_reqs on public.scrape_requests
  for update to anon using (true) with check (true);
