create table if not exists public.quo_manual_routes (
  id uuid primary key default gen_random_uuid(),
  wo_number text not null,
  source_kind text not null default 'live'
    check (source_kind in ('live','yelp','generic')),
  technician_name text,
  technician_phone text not null,
  message_text text not null,
  route_status text not null default 'pending'
    check (route_status in ('pending','copied','sent','responded','accepted','failed')),
  source_url text,
  copied_at timestamptz,
  sent_at timestamptz,
  responded_at timestamptz,
  accepted_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.quo_manual_routes add column if not exists source_kind text not null default 'live';
alter table public.quo_manual_routes drop constraint if exists quo_manual_routes_wo_number_technician_phone_key;
create unique index if not exists quo_manual_routes_wo_source_phone_uidx
  on public.quo_manual_routes (wo_number, source_kind, technician_phone);
create index if not exists quo_manual_routes_wo_source_created_idx
  on public.quo_manual_routes (wo_number, source_kind, created_at desc);

alter table public.quo_manual_routes enable row level security;
drop policy if exists "anon manage quo manual routes" on public.quo_manual_routes;
create policy "anon manage quo manual routes" on public.quo_manual_routes
  for all to anon using (true) with check (true);
