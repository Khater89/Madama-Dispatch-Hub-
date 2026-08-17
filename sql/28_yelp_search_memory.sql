-- MDAMA Yelp Search Memory
-- Safe/idempotent. Stores every Yelp business returned by a Yelp search.
-- This is intentionally separate from public.technicians so search results do
-- not become "hired/known technicians" until the existing Hiring flow does so.

begin;

create extension if not exists "pgcrypto";

create table if not exists public.yelp_search_results (
  id                   uuid primary key default gen_random_uuid(),
  yelp_business_id     text not null unique,
  name                 text,
  phone                text,
  normalized_phone     text,
  primary_trade        text,
  categories           text[] default '{}'::text[],
  rating               numeric(3,2),
  reviews_count        integer default 0,
  source_url           text,
  city                 text,
  state                text,
  zip_code             text,
  latitude             double precision,
  longitude            double precision,
  display_address      text,
  last_search_location text,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  search_count         integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Compatibility if this migration is re-run after future partial changes.
alter table public.yelp_search_results add column if not exists yelp_business_id text;
alter table public.yelp_search_results add column if not exists name text;
alter table public.yelp_search_results add column if not exists phone text;
alter table public.yelp_search_results add column if not exists normalized_phone text;
alter table public.yelp_search_results add column if not exists primary_trade text;
alter table public.yelp_search_results add column if not exists categories text[] default '{}'::text[];
alter table public.yelp_search_results add column if not exists rating numeric(3,2);
alter table public.yelp_search_results add column if not exists reviews_count integer default 0;
alter table public.yelp_search_results add column if not exists source_url text;
alter table public.yelp_search_results add column if not exists city text;
alter table public.yelp_search_results add column if not exists state text;
alter table public.yelp_search_results add column if not exists zip_code text;
alter table public.yelp_search_results add column if not exists latitude double precision;
alter table public.yelp_search_results add column if not exists longitude double precision;
alter table public.yelp_search_results add column if not exists display_address text;
alter table public.yelp_search_results add column if not exists last_search_location text;
alter table public.yelp_search_results add column if not exists first_seen_at timestamptz not null default now();
alter table public.yelp_search_results add column if not exists last_seen_at timestamptz not null default now();
alter table public.yelp_search_results add column if not exists search_count integer not null default 1;
alter table public.yelp_search_results add column if not exists created_at timestamptz not null default now();
alter table public.yelp_search_results add column if not exists updated_at timestamptz not null default now();

create unique index if not exists uq_yelp_search_results_business_id
  on public.yelp_search_results (yelp_business_id);
create index if not exists idx_yelp_search_results_phone
  on public.yelp_search_results (normalized_phone);
create index if not exists idx_yelp_search_results_trade
  on public.yelp_search_results (primary_trade);
create index if not exists idx_yelp_search_results_state_zip
  on public.yelp_search_results (state, zip_code);
create index if not exists idx_yelp_search_results_city_state
  on public.yelp_search_results (city, state);
create index if not exists idx_yelp_search_results_last_seen
  on public.yelp_search_results (last_seen_at desc);

create or replace function public.mdama_yelp_memory_touch()
returns trigger
language plpgsql
as $$
begin
  new.first_seen_at := old.first_seen_at;
  new.last_seen_at := now();
  new.updated_at := now();
  new.search_count := coalesce(old.search_count, 0) + 1;
  return new;
end;
$$;

drop trigger if exists trg_mdama_yelp_memory_touch on public.yelp_search_results;
create trigger trg_mdama_yelp_memory_touch
before update on public.yelp_search_results
for each row execute function public.mdama_yelp_memory_touch();

-- Browser clients do not need direct access. The Yelp Edge Function writes
-- using a Supabase server-side secret/service-role key.
alter table public.yelp_search_results enable row level security;

commit;
