-- ============================================================================
-- 11_candidate_tables.sql
-- Two separate tables to log candidate results for each WO:
--   1) wo_candidates_findclose — results from the "Find Closest" (n8n) button
--   2) wo_candidates_external  — techs added manually via "Add external"
-- Plus a Solo Tech table for external techs to appear in their own tab.
-- ============================================================================

-- === Find Closest results log =================================================
create table if not exists public.wo_candidates_findclose (
  id            uuid primary key default gen_random_uuid(),
  wo_number     text not null,
  wo_id         uuid null,
  rank_position int  not null default 0,
  name          text,
  phone         text,
  phone_display text,
  source_url    text,
  facebook_url  text,
  platform      text,
  snippet       text,
  solo_score    int,
  location_boost int,
  rank_score    int,
  trade         text,
  city          text,
  state         text,
  zip_code      text,
  was_assigned  boolean default false,
  fetched_at    timestamptz default now()
);
create index if not exists idx_findclose_wo    on public.wo_candidates_findclose(wo_number);
create index if not exists idx_findclose_wo_id on public.wo_candidates_findclose(wo_id);
alter table public.wo_candidates_findclose enable row level security;
drop policy if exists p_findclose on public.wo_candidates_findclose;
create policy p_findclose on public.wo_candidates_findclose for all using (true) with check (true);

-- === External tech results log ================================================
create table if not exists public.wo_candidates_external (
  id            uuid primary key default gen_random_uuid(),
  wo_number     text not null,
  wo_id         uuid null,
  name          text,
  phone         text,
  email         text,
  city          text,
  state         text,
  zip_code      text,
  trade         text,
  source_url    text,
  facebook_url  text,
  notes         text,
  was_assigned  boolean default false,
  added_at      timestamptz default now()
);
create index if not exists idx_external_wo    on public.wo_candidates_external(wo_number);
create index if not exists idx_external_wo_id on public.wo_candidates_external(wo_id);
alter table public.wo_candidates_external enable row level security;
drop policy if exists p_external on public.wo_candidates_external;
create policy p_external on public.wo_candidates_external for all using (true) with check (true);

-- === Solo tech tab source view ================================================
-- Any technician that was added via the "external" flow lives in technicians
-- with source_type = 'solo_external'. This view is what the Solo Tech tab reads.
create or replace view public.solo_technicians as
select *
from public.technicians
where coalesce(source_type, '') = 'solo_external'
   or coalesce(source_platform, '') ilike 'solo%'
   or coalesce(source_platform, '') ilike '%external%';

-- === WO assignment lock (only one tech per WO) ===============================
-- Ensure work_orders has a locked_assigned_tech_id column to prevent reassignment.
alter table public.work_orders
  add column if not exists locked_assigned_tech_id uuid null,
  add column if not exists locked_at               timestamptz null;

-- Index locked assignments for fast lookup. work_orders.id is already unique;
-- the canonical assignment integrity rule is installed by v10.9 migration 17.
drop index if exists uniq_wo_assigned_tech;
create index if not exists idx_wo_locked_assigned_tech on public.work_orders (locked_assigned_tech_id)
  where locked_assigned_tech_id is not null;
