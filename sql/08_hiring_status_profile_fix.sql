-- MDAMA Dispatch v8.5
-- Fixes legacy work_order_status_history schemas and enables reusable
-- technician Hiring profiles. Safe to run more than once.

begin;

alter table public.technicians
  add column if not exists hiring_profile jsonb default '{}'::jsonb;
alter table public.technicians
  add column if not exists onboarding_completed boolean default false;
alter table public.technicians
  add column if not exists last_hired_at timestamptz;

alter table public.work_order_status_history
  add column if not exists from_status text;
alter table public.work_order_status_history
  add column if not exists to_status text;
alter table public.work_order_status_history
  add column if not exists old_status text;
alter table public.work_order_status_history
  add column if not exists new_status text;

update public.work_order_status_history
set from_status = coalesce(from_status, old_status),
    to_status   = coalesce(to_status, new_status),
    old_status  = coalesce(old_status, from_status),
    new_status  = coalesce(new_status, to_status)
where from_status is null
   or to_status is null
   or old_status is null
   or new_status is null;

create or replace function public.log_wo_status() returns trigger as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status is null or btrim(new.status) = '' then
      raise exception 'work order status cannot be empty';
    end if;

    insert into public.work_order_status_history
      (work_order_id, from_status, to_status, old_status, new_status)
    values
      (new.id, old.status, new.status, old.status, new.status);
  end if;
  return new;
end
$$ language plpgsql;

drop trigger if exists trg_wo_status on public.work_orders;
create trigger trg_wo_status
after update on public.work_orders
for each row execute function public.log_wo_status();

notify pgrst, 'reload schema';
commit;
