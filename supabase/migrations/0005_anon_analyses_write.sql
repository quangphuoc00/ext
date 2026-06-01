-- 0005_anon_analyses_write.sql  (OptionPilot)
-- The analysis worker (analysisWorker.ts) runs as the anon key and needs to
-- INSERT result rows into `analyses` after claude.ai completes. Without an
-- anon INSERT policy the write silently fails (RLS blocks it), the worker
-- throws "analyses insert failed", and the request is marked error with no
-- result showing in the dashboard.
--
-- Also grant anon SELECT so the worker can query its own output if needed
-- and so the extension popup could surface results directly in future.

drop policy if exists anon_insert_analyses on public.analyses;
create policy anon_insert_analyses on public.analyses
  for insert to anon with check (true);

drop policy if exists anon_read_analyses on public.analyses;
create policy anon_read_analyses on public.analyses
  for select to anon using (true);
