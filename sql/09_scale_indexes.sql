-- ============================================================================
-- 09_scale_indexes.sql
-- Composite indexes so a 100k+ technicians table serves the dispatch app in
-- milliseconds. Every filter Rank Technicians actually uses is covered here.
-- Safe to re-run.
-- ============================================================================
begin;

-- Fast state + trade lookup (Tier 2 in rank-technicians)
create index if not exists idx_tech_state_trade
  on public.technicians (state, primary_trade)
  where is_vendor = false and active = true;

-- Fast ZIP prefix scan (Tier 1 in rank-technicians)
-- text_pattern_ops lets ILIKE 'prefix%' use the index.
create index if not exists idx_tech_zip_prefix
  on public.technicians (zip_code text_pattern_ops)
  where is_vendor = false and active = true;

-- Fast Facebook-only pool
create index if not exists idx_tech_facebook
  on public.technicians (state, primary_trade)
  where facebook_url is not null
    and facebook_url <> ''
    and is_vendor = false
    and active = true;

-- Case-insensitive lookups (in case data has mixed casing)
create index if not exists idx_tech_state_upper
  on public.technicians (upper(state));

-- Secondary trades array contains lookup (for the "cs.{...}" filter)
create index if not exists idx_tech_secondary_trades_gin
  on public.technicians using gin (secondary_trades);

-- Analyze so the planner uses the new indexes right away
analyze public.technicians;

commit;

-- Verify: after running, this should show all four idx_tech_* indexes:
-- select indexname from pg_indexes
-- where schemaname='public' and tablename='technicians'
-- order by indexname;
