-- MDAMA Dispatch v10.20 — direct external Solo Tech fields
-- Safe/idempotent. Run once after sql/19_solo_hiring_list_v10_16.sql.
begin;

alter table public.technicians add column if not exists solo_list_member boolean default false;
alter table public.technicians add column if not exists solo_list_added_at timestamptz;
alter table public.technicians add column if not exists solo_list_source text;
alter table public.technicians add column if not exists job_count integer default 0;
alter table public.technicians add column if not exists licensed boolean;

-- Keep values non-negative when they are supplied.
update public.technicians set job_count = 0 where job_count is not null and job_count < 0;

create index if not exists idx_technicians_solo_external_lookup
  on public.technicians (solo_list_member, state, city, primary_trade)
  where solo_list_member = true;

notify pgrst, 'reload schema';
commit;
