-- MDAMA v10.3 — Independent Company ALL TECHS MAP directory
-- The company map is isolated from public.technicians and all external-tech sources.
-- Safe to run after v10.2. No destructive deletes are performed.

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

create index if not exists idx_company_techs_state_trade
  on public.company_techs (state, primary_trade);
create index if not exists idx_company_techs_zip
  on public.company_techs (zip_code);
create index if not exists idx_company_techs_layer
  on public.company_techs (map_layer);
create index if not exists idx_company_techs_phone
  on public.company_techs (normalized_phone);
create index if not exists idx_company_techs_active
  on public.company_techs (active);

-- Preserve any Company Map records that v10.2 may already have placed in technicians.
-- They are copied into the isolated table once, but the main table is never used by
-- v10.3 Company Map sync.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='technicians' and column_name='company_map_key'
  ) then
    insert into public.company_techs (
      map_key, map_id, map_layer, name, phone, normalized_phone, email, primary_trade,
      city, state, zip_code, latitude, longitude, rating, reviews_count,
      map_address, source_url, notes, active, first_seen_at, last_seen_at, updated_at
    )
    select
      coalesce(t.company_map_key, 'legacy-tech-' || t.id::text),
      '1rRbehqpWKWb0hY9nvQKPpsKy1MI1Oec',
      t.company_map_layer,
      coalesce(t.name, t.business_name, 'Unnamed company tech'),
      t.phone,
      t.normalized_phone,
      t.email,
      t.primary_trade,
      t.city,
      t.state,
      t.zip_code,
      t.latitude,
      t.longitude,
      t.rating,
      t.reviews_count,
      t.company_map_address,
      coalesce(t.company_map_source_url, t.source_url),
      coalesce(t.company_map_notes, t.notes),
      coalesce(t.active,true),
      coalesce(t.created_at,now()),
      coalesce(t.company_map_seen_at,t.updated_at,t.created_at,now()),
      now()
    from public.technicians t
    where coalesce(t.company_map_member,false)=true
       or lower(coalesce(t.source_type,'')) in ('company_map','all_techs_map','google_my_maps')
       or lower(coalesce(t.source_platform,'')) in ('company map','all techs map','google my maps')
    on conflict (map_key) do update set
      map_layer=excluded.map_layer,
      name=excluded.name,
      phone=excluded.phone,
      normalized_phone=excluded.normalized_phone,
      email=excluded.email,
      primary_trade=excluded.primary_trade,
      city=excluded.city,
      state=excluded.state,
      zip_code=excluded.zip_code,
      latitude=excluded.latitude,
      longitude=excluded.longitude,
      rating=excluded.rating,
      reviews_count=excluded.reviews_count,
      map_address=excluded.map_address,
      source_url=excluded.source_url,
      notes=excluded.notes,
      active=excluded.active,
      last_seen_at=excluded.last_seen_at,
      updated_at=now();
  end if;
end $$;

alter table public.company_techs enable row level security;
drop policy if exists company_techs_read on public.company_techs;
create policy company_techs_read on public.company_techs
  for select to anon, authenticated using (true);

grant select on public.company_techs to anon, authenticated;

comment on table public.company_techs is
  'Independent Company ALL TECHS MAP directory. Never merged or synced into public.technicians.';

commit;
