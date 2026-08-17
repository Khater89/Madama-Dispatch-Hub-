-- MDAMA Dispatch v10.22 — technician schema compatibility repair
-- Safe / idempotent. Run once in Supabase SQL Editor.
-- This intentionally includes both older New-Hire compatibility columns and
-- newer Solo Tech columns so mixed deployments stop failing on schema-cache errors.

begin;

alter table public.technicians
  add column if not exists hiring_profile jsonb default '{}'::jsonb;

alter table public.technicians
  add column if not exists onboarding_completed boolean default false;

alter table public.technicians
  add column if not exists last_hired_at timestamptz;

alter table public.technicians
  add column if not exists solo_list_member boolean default false;

alter table public.technicians
  add column if not exists solo_list_added_at timestamptz;

alter table public.technicians
  add column if not exists solo_list_source text;

alter table public.technicians
  add column if not exists job_count integer default 0;

alter table public.technicians
  add column if not exists licensed boolean;

-- History flags used by Solo Tech.
alter table public.technicians
  add column if not exists has_responded boolean default false;
alter table public.technicians
  add column if not exists has_accepted_job boolean default false;
alter table public.technicians
  add column if not exists has_completed_job boolean default false;
alter table public.technicians
  add column if not exists responses_count integer default 0;
alter table public.technicians
  add column if not exists accepted_jobs_count integer default 0;
alter table public.technicians
  add column if not exists completed_jobs_count integer default 0;
alter table public.technicians
  add column if not exists last_response_at timestamptz;
alter table public.technicians
  add column if not exists last_accepted_job_at timestamptz;
alter table public.technicians
  add column if not exists last_completed_job_at timestamptz;

update public.technicians
set job_count = 0
where job_count is null or job_count < 0;

create index if not exists idx_technicians_solo_external_lookup
  on public.technicians (solo_list_member, state, city, primary_trade)
  where solo_list_member = true;

-- Ask PostgREST/Supabase API to refresh its schema cache immediately.
notify pgrst, 'reload schema';

commit;

-- Verification: this result should return every row below.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'technicians'
  and column_name in (
    'hiring_profile','onboarding_completed','last_hired_at',
    'solo_list_member','solo_list_added_at','solo_list_source',
    'job_count','licensed','has_responded','has_accepted_job','has_completed_job'
  )
order by column_name;
