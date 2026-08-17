-- v11.39 — allow automatic Deposit Payment Requests created from individual
-- Diagnosis incurred rows while keeping ordinary manual Deposits protected.
-- Run this entire file once in the Supabase SQL Editor.

drop trigger if exists trg_prepare_payment_request on public.payment_requests;
drop function if exists public.prepare_payment_request() cascade;

create function public.prepare_payment_request() returns trigger as $$
declare
  normalized_status text;
  wo_stage text;
  stage_payload jsonb;
  is_diagnosis_auto boolean;
begin
  normalized_status := lower(replace(trim(coalesce(new.status, '')), ' ', '_'));
  if normalized_status = 'job_done' then normalized_status := 'work_done'; end if;
  if normalized_status not in ('assessment_completed','deposit','work_done') then
    raise exception 'Choose a valid payment request status first.';
  end if;

  is_diagnosis_auto := coalesce(new.structured_data->>'created_from','') = 'diagnosis_incurred_auto'
    and nullif(new.structured_data->>'diagnosis_incurred_id','') is not null;

  select lower(replace(trim(coalesce(workflow_stage,status,'')), ' ', '_')) into wo_stage
  from public.work_orders where id=new.work_order_id;

  if normalized_status='assessment_completed' then
    select data into stage_payload from public.work_order_stage_data
    where work_order_id=new.work_order_id and stage='diagnosis' and completed=true;
    if stage_payload is null or nullif(stage_payload->>'repair_plan','') is null
    then raise exception 'Assessment payment requires completed Diagnosis.';
    end if;
  elsif normalized_status='deposit' then
    if is_diagnosis_auto then
      select data into stage_payload from public.work_order_stage_data
      where work_order_id=new.work_order_id and stage='diagnosis' and completed=true;
      if stage_payload is null then
        raise exception 'Automatic incurred payment requires completed Diagnosis.';
      end if;
    else
      select data into stage_payload from public.work_order_stage_data
      where work_order_id=new.work_order_id and stage='approval' and completed=true;
      if stage_payload is null
        or coalesce((stage_payload->>'deposit_authorized')::boolean,false)=false
        or not exists(select 1 from public.work_orders where id=new.work_order_id and nullif(quote_text,'') is not null)
      then raise exception 'Manual Deposit requires an approved Quote and explicit TL deposit authorization.';
      end if;
    end if;
  elsif normalized_status='work_done' then
    select data into stage_payload from public.work_order_stage_data
    where work_order_id=new.work_order_id and stage='completion' and completed=true;
    if wo_stage<>'work_done'
      or stage_payload is null
      or coalesce((stage_payload->>'after_photos_received')::boolean,false)=false
      or coalesce((stage_payload->>'signoff_verified')::boolean,false)=false
      or coalesce((stage_payload->>'manager_confirmed')::boolean,false)=false
      or (select count(*) from public.work_order_files where work_order_id=new.work_order_id and stage='completion' and file_type='after_photo') < 4
      or (select count(*) from public.work_order_files where work_order_id=new.work_order_id and stage='completion' and file_type='signoff') < 1
    then raise exception 'Job Done requires Work Done, 4 uploaded After Photos, uploaded signed Sign-Off Sheet, and Manager confirmation.';
    end if;
  end if;

  new.status := normalized_status;
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

create trigger trg_prepare_payment_request before insert or update on public.payment_requests
  for each row execute function public.prepare_payment_request();

create unique index if not exists uq_payment_diagnosis_incurred
  on public.payment_requests (work_order_id, ((structured_data->>'diagnosis_incurred_id')))
  where structured_data->>'created_from' = 'diagnosis_incurred_auto';

notify pgrst, 'reload schema';

select pg_get_functiondef('public.prepare_payment_request()'::regprocedure) as installed_function;
