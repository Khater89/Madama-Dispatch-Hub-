-- MDAMA v10.1 — Company Map source support
-- Safe and idempotent. Does not delete or rewrite technician data.
begin;

create index if not exists idx_technicians_source_type
  on public.technicians (source_type);

create or replace view public.technicians_company_map as
select *
from public.technicians
where lower(coalesce(source_type,'')) in ('company_map','all_techs_map','google_my_maps')
   or lower(coalesce(source_platform,'')) in ('company map','all techs map','google my maps')
   or lower(coalesce(notes,'')) like '%all techs map%';

grant select on public.technicians_company_map to anon, authenticated;

commit;
