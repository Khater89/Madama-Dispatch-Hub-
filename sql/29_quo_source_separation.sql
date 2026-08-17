-- Run once on an existing MDAMA database that already has quo_manual_routes.
-- This makes Live Search and Yelp Quo queues persist independently.

alter table public.quo_manual_routes
  add column if not exists source_kind text not null default 'generic';

-- Best-effort classification of historical records.
update public.quo_manual_routes
set source_kind = case
  when coalesce(source_url,'') ilike '%yelp.%' then 'yelp'
  when source_kind = 'generic' then 'live'
  else source_kind
end;

alter table public.quo_manual_routes
  drop constraint if exists quo_manual_routes_wo_number_technician_phone_key;

drop index if exists quo_manual_routes_wo_number_technician_phone_key;

create unique index if not exists quo_manual_routes_wo_source_phone_uidx
  on public.quo_manual_routes (wo_number, source_kind, technician_phone);

create index if not exists quo_manual_routes_wo_source_created_idx
  on public.quo_manual_routes (wo_number, source_kind, created_at desc);
