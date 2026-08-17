-- MDAMA v10.2 — Company ALL TECHS MAP inside Solo Tech
-- Safe/idempotent migration. Keeps existing technician history and avoids duplicates.
begin;

alter table public.technicians add column if not exists company_map_member boolean default false;
alter table public.technicians add column if not exists company_map_key text;
alter table public.technicians add column if not exists company_map_layer text;
alter table public.technicians add column if not exists company_map_address text;
alter table public.technicians add column if not exists company_map_source_url text;
alter table public.technicians add column if not exists company_map_notes text;
alter table public.technicians add column if not exists company_map_seen_at timestamptz;

create unique index if not exists uq_technicians_company_map_key
  on public.technicians (company_map_key)
  where company_map_key is not null;

create index if not exists idx_technicians_company_map_member
  on public.technicians (company_map_member, active);

create index if not exists idx_technicians_company_map_filters
  on public.technicians (company_map_member, primary_trade, state, zip_code)
  where company_map_member = true;

-- Preserve v10.1 records that were already labeled as Company Map.
update public.technicians
set company_map_member = true
where lower(coalesce(source_type,'')) in ('company_map','all_techs_map','google_my_maps')
   or lower(coalesce(source_platform,'')) in ('company map','all techs map','google my maps')
   or lower(coalesce(notes,'')) like '%all techs map%';

create or replace view public.technicians_company_map as
select *
from public.technicians
where company_map_member = true;

grant select on public.technicians_company_map to anon, authenticated;

commit;
