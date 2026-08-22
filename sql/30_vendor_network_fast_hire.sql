-- ============================================================================
-- 30_vendor_network_fast_hire.sql  (RESTORED in v12.1)
-- index.html calls /rest/v1/vendors and /rest/v1/vendor_technicians, and
-- loadVendors() tells the user to "Run sql/30_vendor_network_fast_hire.sql",
-- but the file was never shipped in this package. Without it the Vendors tab
-- fails with PGRST205 and every "add to Vendors" action throws.
--
-- Column list is derived from the payloads the app actually sends:
--   ensureVendorFromCandidate() -> vendors
--   saveVendorTechnicianQuick() -> vendor_technicians
-- Idempotent. Safe to run on an existing project.
-- ============================================================================
begin;

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- VENDORS (a company that supplies technicians, as opposed to a Solo tech)
-- ---------------------------------------------------------------------------
create table if not exists public.vendors (
  id                uuid primary key default gen_random_uuid(),
  name              text,
  business_name     text,
  contact_name      text,
  phone             text,
  normalized_phone  text,
  email             text,
  primary_trade     text,
  city              text,
  state             text,
  zip_code          text,
  latitude          double precision,
  longitude         double precision,
  source_kind       text,          -- yelp | live_search | solo_db | company_map_independent | manual | *_moved_to_vendor
  source_platform   text,
  source_url        text,
  payment_method    text,
  jobs_count        integer default 0,
  notes             text,
  active            boolean default true,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

alter table public.vendors add column if not exists name text;
alter table public.vendors add column if not exists business_name text;
alter table public.vendors add column if not exists contact_name text;
alter table public.vendors add column if not exists phone text;
alter table public.vendors add column if not exists normalized_phone text;
alter table public.vendors add column if not exists email text;
alter table public.vendors add column if not exists primary_trade text;
alter table public.vendors add column if not exists city text;
alter table public.vendors add column if not exists state text;
alter table public.vendors add column if not exists zip_code text;
alter table public.vendors add column if not exists latitude double precision;
alter table public.vendors add column if not exists longitude double precision;
alter table public.vendors add column if not exists source_kind text;
alter table public.vendors add column if not exists source_platform text;
alter table public.vendors add column if not exists source_url text;
alter table public.vendors add column if not exists payment_method text;
alter table public.vendors add column if not exists jobs_count integer default 0;
alter table public.vendors add column if not exists notes text;
alter table public.vendors add column if not exists active boolean default true;
alter table public.vendors add column if not exists created_at timestamptz default now();
alter table public.vendors add column if not exists updated_at timestamptz default now();

-- ensureVendorFromCandidate() looks a vendor up by normalized_phone and by
-- source_url before inserting, so both need a unique index to make that
-- de-dupe reliable under concurrent dispatchers.
create unique index if not exists idx_vendors_unique_phone
  on public.vendors (normalized_phone) where normalized_phone is not null;
create unique index if not exists idx_vendors_unique_source_url
  on public.vendors (source_url) where source_url is not null;
create index if not exists idx_vendors_trade_state
  on public.vendors (primary_trade, state, city);
-- renderVendors() sorts on updated_at desc nullslast
create index if not exists idx_vendors_updated
  on public.vendors (updated_at desc nulls last);

-- ---------------------------------------------------------------------------
-- VENDOR TECHNICIANS (the individual techs a vendor sends to a job)
-- ---------------------------------------------------------------------------
create table if not exists public.vendor_technicians (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         uuid not null references public.vendors(id) on delete cascade,
  technician_id     uuid references public.technicians(id) on delete set null,
  name              text,
  phone             text,
  normalized_phone  text,
  primary_trade     text,
  city              text,
  state             text,
  zip_code          text,
  payment_method    text,
  active            boolean default true,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

alter table public.vendor_technicians add column if not exists vendor_id uuid;
alter table public.vendor_technicians add column if not exists technician_id uuid;
alter table public.vendor_technicians add column if not exists name text;
alter table public.vendor_technicians add column if not exists phone text;
alter table public.vendor_technicians add column if not exists normalized_phone text;
alter table public.vendor_technicians add column if not exists primary_trade text;
alter table public.vendor_technicians add column if not exists city text;
alter table public.vendor_technicians add column if not exists state text;
alter table public.vendor_technicians add column if not exists zip_code text;
alter table public.vendor_technicians add column if not exists payment_method text;
alter table public.vendor_technicians add column if not exists active boolean default true;
alter table public.vendor_technicians add column if not exists created_at timestamptz default now();
alter table public.vendor_technicians add column if not exists updated_at timestamptz default now();

create unique index if not exists idx_vendor_tech_unique_phone_per_vendor
  on public.vendor_technicians (vendor_id, normalized_phone)
  where normalized_phone is not null;
create index if not exists idx_vendor_tech_vendor on public.vendor_technicians (vendor_id);
create index if not exists idx_vendor_tech_updated
  on public.vendor_technicians (updated_at desc nulls last);

-- ---------------------------------------------------------------------------
-- Columns the app writes onto existing tables for vendor classification
-- ---------------------------------------------------------------------------
alter table public.technicians  add column if not exists is_vendor boolean default false;
alter table public.technicians  add column if not exists vendor_id uuid references public.vendors(id) on delete set null;
alter table public.technicians  add column if not exists vendor_marked_at timestamptz;
alter table public.technicians  add column if not exists solo_list_member boolean default false;
create index if not exists idx_technicians_vendor on public.technicians (vendor_id) where vendor_id is not null;

-- vendorBookedWOs() filters work_orders on assigned_vendor_id
alter table public.work_orders add column if not exists assigned_vendor_id uuid references public.vendors(id) on delete set null;
create index if not exists idx_work_orders_vendor on public.work_orders (assigned_vendor_id) where assigned_vendor_id is not null;

-- ---------------------------------------------------------------------------
-- Keep normalized_phone / updated_at honest (the app relies on both)
-- ---------------------------------------------------------------------------
create or replace function public.normalize_vendor_row() returns trigger as $$
declare d text;
begin
  d := regexp_replace(coalesce(new.phone,''), '\D', '', 'g');
  if length(d) = 11 and left(d,1) = '1' then d := substr(d,2); end if;
  if length(d) = 10 then
    new.normalized_phone := d;
  elsif coalesce(new.normalized_phone,'') = '' then
    new.normalized_phone := null;
  end if;
  new.updated_at := now();
  return new;
end $$ language plpgsql;

drop trigger if exists trg_normalize_vendor on public.vendors;
create trigger trg_normalize_vendor before insert or update on public.vendors
  for each row execute function public.normalize_vendor_row();

drop trigger if exists trg_normalize_vendor_tech on public.vendor_technicians;
create trigger trg_normalize_vendor_tech before insert or update on public.vendor_technicians
  for each row execute function public.normalize_vendor_row();

-- jobs_count is displayed per vendor in renderVendors(); keep it maintained
-- from work_orders instead of trusting the client to increment it.
create or replace function public.refresh_vendor_jobs_count() returns trigger as $$
begin
  if tg_op in ('INSERT','UPDATE') and new.assigned_vendor_id is not null then
    update public.vendors v
       set jobs_count = (select count(*) from public.work_orders w where w.assigned_vendor_id = v.id)
     where v.id = new.assigned_vendor_id;
  end if;
  if tg_op = 'UPDATE' and old.assigned_vendor_id is not null
     and old.assigned_vendor_id is distinct from new.assigned_vendor_id then
    update public.vendors v
       set jobs_count = (select count(*) from public.work_orders w where w.assigned_vendor_id = v.id)
     where v.id = old.assigned_vendor_id;
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_refresh_vendor_jobs_count on public.work_orders;
create trigger trg_refresh_vendor_jobs_count
  after insert or update of assigned_vendor_id on public.work_orders
  for each row execute function public.refresh_vendor_jobs_count();

commit;
