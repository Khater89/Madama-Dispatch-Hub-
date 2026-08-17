-- MDAMA v10.8 — Quote / Payment workflow migration
-- Safe to run on an existing database after 00_RUN_THIS_FIRST.sql.

-- Work Done no longer blocks additional Payment Requests.
drop index if exists public.idx_one_final_payment_per_wo;
create index if not exists idx_payment_requests_status
  on public.payment_requests (work_order_id,status,created_at);

create or replace function public.prepare_payment_request() returns trigger as $$
declare
  normalized_status text;
  wo_stage text;
  stage_payload jsonb;
begin
  normalized_status := lower(replace(trim(coalesce(new.status, '')), ' ', '_'));
  if normalized_status = 'job_done' then normalized_status := 'work_done'; end if;
  if normalized_status not in ('assessment_completed','deposit','work_done') then
    raise exception 'Choose a valid payment request status first.';
  end if;

  select coalesce(workflow_stage,status) into wo_stage
  from public.work_orders where id=new.work_order_id;

  if normalized_status='assessment_completed' then
    select data into stage_payload from public.work_order_stage_data
    where work_order_id=new.work_order_id and stage='diagnosis' and completed=true;
    if stage_payload is null
      or coalesce(stage_payload->>'technical_diagnosis','')=''
      or coalesce(stage_payload->>'repair_plan','')=''
      or not (stage_payload ? 'technician_total_cost')
      or (select count(*) from public.work_order_files where work_order_id=new.work_order_id and stage='diagnosis' and file_type='before_photo') < 4
    then raise exception 'Assessment payment requires completed Diagnosis, 4 Before photos, full breakdown/specs, and final technician price.';
    end if;
  elsif normalized_status='deposit' then
    select data into stage_payload from public.work_order_stage_data
    where work_order_id=new.work_order_id and stage='approval' and completed=true;
    if stage_payload is null
      or coalesce((stage_payload->>'deposit_authorized')::boolean,false)=false
      or not exists(select 1 from public.work_orders where id=new.work_order_id and nullif(quote_text,'') is not null)
    then raise exception 'Deposit requires an approved Quote and explicit TL deposit authorization.';
    end if;
  elsif normalized_status='work_done' then
    select data into stage_payload from public.work_order_stage_data
    where work_order_id=new.work_order_id and stage='completion' and completed=true;
    if wo_stage<>'work_done'
      or stage_payload is null
      or coalesce((stage_payload->>'manager_confirmed')::boolean,false)=false
      or coalesce((stage_payload->>'signoff_verified')::boolean,false)=false
      or (select count(*) from public.work_order_files where work_order_id=new.work_order_id and stage='completion' and file_type='after_photo') < 4
      or (select count(*) from public.work_order_files where work_order_id=new.work_order_id and stage='completion' and file_type='signoff') < 1
    then raise exception 'Job Done payment requires WO status Work Done, 4 After photos, verified sign-off, and manager confirmation.';
    end if;
  end if;

  new.status := normalized_status;
  -- Informational only in v10.8; a Job Done request does not close payment entry.
  new.is_final := false;
  new.amount_due := coalesce(new.amount_due, 0);
  new.incurred := coalesce(new.incurred, 0);
  new.total_cost := new.amount_due + new.incurred;
  if new.sequence_number is null then
    select coalesce(max(p.sequence_number), 0) + 1 into new.sequence_number
    from public.payment_requests p where p.work_order_id = new.work_order_id;
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_prepare_payment_request on public.payment_requests;
create trigger trg_prepare_payment_request before insert or update on public.payment_requests
  for each row execute function public.prepare_payment_request();

notify pgrst, 'reload schema';
