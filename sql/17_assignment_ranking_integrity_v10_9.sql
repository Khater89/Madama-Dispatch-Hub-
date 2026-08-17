-- MDAMA v10.9 — Assignment / workflow integrity repair
-- Run once after the existing v10.8 migrations.
-- This migration does not remove data.

-- The previous "unique" partial index was on work_orders.id, which is already
-- the primary key and therefore did not add any useful assignment protection.
drop index if exists public.uniq_wo_assigned_tech;
create index if not exists idx_wo_locked_assigned_tech
  on public.work_orders (locked_assigned_tech_id)
  where locked_assigned_tech_id is not null;

-- Repair WOs that were locked by the New Hiring modal but never mirrored into
-- assigned_technician_id. The workflow reads assigned_technician_id everywhere.
update public.work_orders
set assigned_technician_id = locked_assigned_tech_id,
    updated_at = now()
where locked_assigned_tech_id is not null
  and assigned_technician_id is distinct from locked_assigned_tech_id;

-- A locked/hired technician means New Hiring is complete. Move only records
-- that are still stuck at the initial stage; do not rewind any later workflow.
update public.work_orders
set workflow_stage = 'en_route',
    status = 'en_route',
    follow_up_tag = 'En Route',
    stage_updated_at = now(),
    updated_at = now()
where locked_assigned_tech_id is not null
  and coalesce(workflow_stage, status, 'new_hiring') in ('new', 'new_hiring', 'tech_hired');

-- Make old locked assignments count as a completed New Hiring stage so the
-- Workflow opens at Arrival instead of asking to hire the same technician again.
insert into public.work_order_stage_data
  (work_order_id, stage, data, completed, completed_at, updated_at)
select id, 'new_hiring', jsonb_build_object('repaired_from_locked_assignment', true), true, now(), now()
from public.work_orders
where locked_assigned_tech_id is not null
on conflict (work_order_id, stage) do update
set completed = true,
    completed_at = coalesce(public.work_order_stage_data.completed_at, excluded.completed_at),
    updated_at = excluded.updated_at;

-- Database safety net: whenever a caller sets locked_assigned_tech_id, keep the
-- canonical assigned_technician_id in sync and advance an untouched Hiring WO.
create or replace function public.sync_mdama_locked_assignment() returns trigger as $$
begin
  if new.locked_assigned_tech_id is not null then
    new.assigned_technician_id := new.locked_assigned_tech_id;

    if coalesce(new.workflow_stage, new.status, 'new_hiring') in ('new', 'new_hiring', 'tech_hired') then
      new.workflow_stage := 'en_route';
      new.status := 'en_route';
      new.follow_up_tag := 'En Route';
      new.stage_updated_at := now();
    end if;
  end if;

  new.updated_at := now();
  return new;
end $$ language plpgsql;

drop trigger if exists trg_sync_mdama_locked_assignment on public.work_orders;
create trigger trg_sync_mdama_locked_assignment
before insert or update of locked_assigned_tech_id, assigned_technician_id, workflow_stage, status
on public.work_orders
for each row execute function public.sync_mdama_locked_assignment();

notify pgrst, 'reload schema';
