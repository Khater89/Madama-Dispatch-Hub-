-- MDAMA v10.4 — ONE-TIME Company ALL TECHS MAP setup
-- Run this once in Supabase SQL Editor.
-- This source remains fully independent from public.technicians.

begin;
create extension if not exists pgcrypto;

create table if not exists public.company_techs (
  id uuid primary key default gen_random_uuid(),
  map_key text not null unique,
  map_id text,
  map_layer text,
  name text,
  phone text,
  normalized_phone text,
  email text,
  primary_trade text,
  city text,
  state text,
  zip_code text,
  latitude double precision,
  longitude double precision,
  rating numeric,
  reviews_count integer,
  map_address text,
  source_url text,
  notes text,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_company_techs_state_trade on public.company_techs (state, primary_trade);
create index if not exists idx_company_techs_zip on public.company_techs (zip_code);
create index if not exists idx_company_techs_layer on public.company_techs (map_layer);
create index if not exists idx_company_techs_phone on public.company_techs (normalized_phone);
create index if not exists idx_company_techs_active on public.company_techs (active);

alter table public.company_techs enable row level security;
drop policy if exists company_techs_read on public.company_techs;
create policy company_techs_read on public.company_techs for select to anon, authenticated using (true);
grant select on public.company_techs to anon, authenticated;

comment on table public.company_techs is 'Independent Company ALL TECHS MAP directory used only by Solo Tech.';
commit;
