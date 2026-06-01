-- 0003_analysis_requests_dedupe.sql  (OptionPilot)
-- Collapse duplicate analysis requests across ALL extension instances.
--
-- Multiple browsers each run the analysis worker and react to the same Realtime
-- INSERT events, so an in-memory queue can only dedupe within a single browser.
-- To guarantee "run once" globally we enforce the invariant at the database:
-- at most one ACTIVE (pending or running) request may exist per
-- (user_id, symbol, mode). A second request for the same target is rejected
-- while one is still in flight; once a request reaches done/error it no longer
-- blocks a fresh request.
--
-- mode is nullable, so the index keys on coalesce(mode,'routine') to match the
-- worker's own default (req.mode ?? 'routine') and keep NULL/'routine' unified.

-- ============================================================================
-- 1. Resolve any pre-existing duplicate active requests so the unique index can
--    be created. Keep one row per (user_id, symbol, mode): prefer a 'running'
--    row (likely already being processed), else the most recently requested
--    'pending' row. Demote the rest to 'error'.
-- ============================================================================
with ranked as (
  select id,
         row_number() over (
           partition by user_id, symbol, coalesce(mode, 'routine')
           order by (status = 'running') desc, requested_at desc
         ) as rn
  from public.analysis_requests
  where status in ('pending', 'running')
)
update public.analysis_requests a
set status = 'error',
    error = 'superseded by a duplicate request',
    completed_at = now()
from ranked
where a.id = ranked.id
  and ranked.rn > 1;

-- ============================================================================
-- 2. One active request per (user, symbol, mode).
-- ============================================================================
create unique index if not exists uq_analysis_requests_active
  on public.analysis_requests (user_id, symbol, coalesce(mode, 'routine'))
  where status in ('pending', 'running');
