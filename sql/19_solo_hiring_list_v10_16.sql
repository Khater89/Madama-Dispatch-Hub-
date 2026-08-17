-- MDAMA Dispatch v10.16 — Solo Tech list membership for hired technicians
-- Safe/idempotent. Run once after the previous migrations.
begin;

alter table public.technicians add column if not exists solo_list_member boolean default false;
alter table public.technicians add column if not exists solo_list_added_at timestamptz;
alter table public.technicians add column if not exists solo_list_source text;

create index if not exists idx_technicians_solo_list
  on public.technicians (solo_list_member, solo_list_added_at desc)
  where solo_list_member = true;

-- Backfill technicians that were already hired/accepted in older MDAMA versions.
update public.technicians
set
  solo_list_member = true,
  solo_list_added_at = coalesce(solo_list_added_at, last_hired_at, last_accepted_job_at, created_at, now()),
  solo_list_source = coalesce(
    solo_list_source,
    case
      when lower(coalesce(source_type,'')) = 'company_hired_copy' then 'company_map_hire'
      when lower(coalesce(source_type,'')) = 'solo_external' then 'external_hire'
      else 'existing_hire'
    end
  )
where coalesce(solo_list_member,false) = false
  and (
    coalesce(onboarding_completed,false) = true
    or coalesce(has_accepted_job,false) = true
    or coalesce(accepted_jobs_count,0) > 0
    or lower(coalesce(source_type,'')) in ('company_hired_copy','solo_external')
  );

notify pgrst, 'reload schema';
commit;
