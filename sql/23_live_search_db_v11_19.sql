-- ============================================================================
-- 23_live_search_db_v11_19.sql  (RESTORED in v12.1)
-- index.html calls /rest/v1/live_search_technicians but this migration was
-- missing from the package, so the Live Search DB tab returned PGRST205
-- ("Could not find the table 'public.live_search_technicians'").
-- Idempotent. Safe to run on an existing project.
-- ============================================================================
begin;

create extension if not exists "pgcrypto";

create table if not exists public.live_search_technicians (
  id                uuid primary key default gen_random_uuid(),
  name              text,
  business_name     text,
  phone             text,
  normalized_phone  text,
  email             text,
  trade             text,
  city              text,
  state             text,
  zip_code          text,
  latitude          double precision,
  longitude         double precision,
  rating            numeric(3,2),
  reviews_count     integer default 0,
  distance_miles    numeric(8,2),
  source_platform   text,
  source_url        text,
  raw               jsonb default '{}'::jsonb,
  work_order_id     uuid references public.work_orders(id) on delete set null,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

alter table public.live_search_technicians add column if not exists normalized_phone text;
alter table public.live_search_technicians add column if not exists trade text;
alter table public.live_search_technicians add column if not exists latitude double precision;
alter table public.live_search_technicians add column if not exists longitude double precision;
alter table public.live_search_technicians add column if not exists distance_miles numeric(8,2);
alter table public.live_search_technicians add column if not exists source_platform text;
alter table public.live_search_technicians add column if not exists source_url text;
alter table public.live_search_technicians add column if not exists raw jsonb default '{}'::jsonb;
alter table public.live_search_technicians add column if not exists work_order_id uuid;
alter table public.live_search_technicians add column if not exists updated_at timestamptz default now();

-- keep normalized_phone honest so the app's de-dupe / exclusion logic works
create or replace function public.normalize_live_search_phone() returns trigger as $$
declare d text;
begin
  d := regexp_replace(coalesce(new.phone,''), '\D', '', 'g');
  if length(d) = 11 and left(d,1) = '1' then d := substr(d,2); end if;
  new.normalized_phone := case when length(d) = 10 then d else null end;
  new.updated_at := now();
  return new;
end $$ language plpgsql;

drop trigger if exists trg_normalize_live_search_phone on public.live_search_technicians;
create trigger trg_normalize_live_search_phone
  before insert or update on public.live_search_technicians
  for each row execute function public.normalize_live_search_phone();

create unique index if not exists idx_live_search_unique_phone
  on public.live_search_technicians (normalized_phone)
  where normalized_phone is not null;
create index if not exists idx_live_search_trade_state
  on public.live_search_technicians (trade, state, city);
create index if not exists idx_live_search_wo
  on public.live_search_technicians (work_order_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Phone exclusion list (index.html calls /rest/v1/search_phone_exclusions)
-- ---------------------------------------------------------------------------
create table if not exists public.search_phone_exclusions (
  normalized_phone text primary key,
  reason           text,
  excluded_by      uuid,
  created_at       timestamptz default now()
);
alter table public.search_phone_exclusions add column if not exists reason text;
alter table public.search_phone_exclusions add column if not exists excluded_by uuid;

commit;
