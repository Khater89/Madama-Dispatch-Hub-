-- ============================================================================
-- 06_source_views.sql
-- Adds source-labelled views and a state-sorted view for technician leads.
-- Safe to re-run. Does not update or delete technician rows.
-- ============================================================================
begin;

create index if not exists idx_tech_source_platform
  on public.technicians (source_platform);

create or replace view public.technicians_by_state
  with (security_invoker = true) as
  select *
  from public.technicians
  order by state nulls last, city nulls last, primary_trade nulls last,
           coalesce(name, business_name) nulls last, normalized_phone;

create or replace view public.technicians_google_maps
  with (security_invoker = true) as
  select *
  from public.technicians
  where coalesce(source_platform, '') ilike '%Google Maps%'
  order by state nulls last, city nulls last, primary_trade nulls last,
           coalesce(name, business_name) nulls last;

create or replace view public.technicians_facebook
  with (security_invoker = true) as
  select *
  from public.technicians
  where coalesce(source_platform, '') ilike '%Facebook%'
  order by state nulls last, city nulls last, primary_trade nulls last,
           coalesce(name, business_name) nulls last;

create or replace view public.technicians_instagram
  with (security_invoker = true) as
  select *
  from public.technicians
  where coalesce(source_platform, '') ilike '%Instagram%'
  order by state nulls last, city nulls last, primary_trade nulls last,
           coalesce(name, business_name) nulls last;

grant select on public.technicians_by_state to anon;
grant select on public.technicians_google_maps to anon;
grant select on public.technicians_facebook to anon;
grant select on public.technicians_instagram to anon;

notify pgrst, 'reload schema';
commit;
