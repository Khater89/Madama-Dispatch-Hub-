-- ============================================================================
-- MDAMA Dispatch v7 — End-to-end WO workflow schema (idempotent)
-- Safe to run on the existing project. Adds tables/columns if missing,
-- never drops data. Run once in Supabase -> SQL Editor.
-- ============================================================================
begin;

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- TECHNICIANS
-- ---------------------------------------------------------------------------
create table if not exists public.technicians (
  id                       uuid primary key default gen_random_uuid(),
  name                     text,
  business_name            text,
  contact_owner            text,
  phone                    text,
  normalized_phone         text,
  email                    text,
  primary_trade            text,
  secondary_trades         text[],
  city                     text,
  state                    text,
  zip_code                 text,
  latitude                 double precision,
  longitude                double precision,
  rating                   numeric(3,2),
  reviews_count            integer default 0,
  responses_count          integer default 0,
  accepted_jobs_count      integer default 0,
  completed_jobs_count     integer default 0,
  has_responded            boolean default false,
  has_accepted_job         boolean default false,
  has_completed_job        boolean default false,
  is_vendor                boolean default false,
  is_external              boolean default false,
  profile_incomplete       boolean default false,
  active                   boolean default true,
  source_type              text,
  source_platform          text,
  source_url               text,
  facebook_url             text,
  hiring_profile           jsonb default '{}'::jsonb,
  onboarding_completed     boolean default false,
  last_hired_at            timestamptz,
  notes                    text,
  last_response_at         timestamptz,
  last_accepted_job_at     timestamptz,
  last_completed_job_at    timestamptz,
  vendor_marked_at         timestamptz,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now()
);

-- Compatibility layer for older MDAMA tables.  `create table if not exists`
-- does not add columns to a table that already exists, so every column used by
-- the app, indexes, or triggers must be added explicitly before it is touched.
alter table public.technicians add column if not exists name text;
alter table public.technicians add column if not exists business_name text;
alter table public.technicians add column if not exists contact_owner text;
alter table public.technicians add column if not exists phone text;
alter table public.technicians add column if not exists normalized_phone text;
alter table public.technicians add column if not exists email text;
alter table public.technicians add column if not exists primary_trade text;
alter table public.technicians add column if not exists secondary_trades text[];
alter table public.technicians add column if not exists city text;
alter table public.technicians add column if not exists state text;
alter table public.technicians add column if not exists zip_code text;
alter table public.technicians add column if not exists latitude double precision;
alter table public.technicians add column if not exists longitude double precision;
alter table public.technicians add column if not exists rating numeric(3,2);
alter table public.technicians add column if not exists reviews_count integer default 0;
alter table public.technicians add column if not exists responses_count integer default 0;
alter table public.technicians add column if not exists accepted_jobs_count integer default 0;
alter table public.technicians add column if not exists completed_jobs_count integer default 0;
alter table public.technicians add column if not exists has_responded boolean default false;
alter table public.technicians add column if not exists has_accepted_job boolean default false;
alter table public.technicians add column if not exists has_completed_job boolean default false;
alter table public.technicians add column if not exists is_vendor boolean default false;
alter table public.technicians add column if not exists is_external boolean default false;
alter table public.technicians add column if not exists profile_incomplete boolean default false;
alter table public.technicians add column if not exists notes text;
alter table public.technicians add column if not exists active boolean default true;
alter table public.technicians add column if not exists source_type text;
alter table public.technicians add column if not exists source_platform text;
alter table public.technicians add column if not exists source_url text;
alter table public.technicians add column if not exists facebook_url text;
alter table public.technicians add column if not exists hiring_profile jsonb default '{}'::jsonb;
alter table public.technicians add column if not exists onboarding_completed boolean default false;
alter table public.technicians add column if not exists last_hired_at timestamptz;
alter table public.technicians add column if not exists last_response_at timestamptz;
alter table public.technicians add column if not exists last_accepted_job_at timestamptz;
alter table public.technicians add column if not exists last_completed_job_at timestamptz;
alter table public.technicians add column if not exists vendor_marked_at timestamptz;
alter table public.technicians add column if not exists created_at timestamptz default now();
alter table public.technicians add column if not exists updated_at timestamptz default now();

-- Earlier MDAMA builds used `trade` instead of `primary_trade`.  Preserve that
-- data so the rank-technicians function does not return an empty result after
-- this migration adds the new column.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'technicians'
      and column_name = 'trade'
  ) then
    execute $sql$
      update public.technicians
      set primary_trade = trade::text
      where primary_trade is null and trade is not null
    $sql$;
  end if;
end $$;

create index if not exists idx_tech_trade   on public.technicians (primary_trade);
create index if not exists idx_tech_state   on public.technicians (state);
create index if not exists idx_tech_city    on public.technicians (city);
create index if not exists idx_tech_vendor  on public.technicians (is_vendor);
create index if not exists idx_tech_phone   on public.technicians (normalized_phone);
create index if not exists idx_tech_geo     on public.technicians (latitude, longitude);

-- ---------------------------------------------------------------------------
-- WORK ORDERS
-- ---------------------------------------------------------------------------
create table if not exists public.work_orders (
  id                       uuid primary key default gen_random_uuid(),
  wo_number                text,
  raw_wo_text              text,
  trade                    text,
  description              text,
  priority                 text default 'normal',   -- low | normal | high | emergency
  street                   text,
  city                     text,
  state                    text,
  zip_code                 text,
  latitude                 double precision,
  longitude                double precision,
  status                   text default 'new',      -- new|searching_techs|tech_contacted|tech_responded|tech_accepted|scheduled|in_progress|completed|cancelled
  scheduled_for            timestamptz,
  technician_eta_at        timestamptz,
  assigned_technician_id   uuid references public.technicians(id) on delete set null,
  ai_analysis              jsonb,
  document_type            text default 'work_order',
  external_id              text,
  job_type                 text,
  commitment_at            timestamptz,
  record_type              text,
  alert_status             text,
  special_handling         text,
  region                   text,
  timezone                 text,
  wrid                     text,
  location_contact         text,
  contact_number           text,
  turf                     text,
  requester                text,
  noc_phone                text,
  client_name              text,
  store_name               text,
  store_number             text,
  full_address             text,
  nte                      numeric(12,2),
  currency                 text default 'USD',
  eta_code                 text,
  requested_arrival_at     timestamptz,
  special_instructions     text,
  problem_summary          text,
  follow_up_tag            text default 'New',
  quote_text               text,
  payment_request_text     text,
  best_contact             text,
  best_contact_phone       text,
  sow                      text,
  extracted_fields         jsonb default '{}'::jsonb,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now()
);

alter table public.work_orders add column if not exists wo_number text;
alter table public.work_orders add column if not exists raw_wo_text text;
alter table public.work_orders add column if not exists trade text;
alter table public.work_orders add column if not exists description text;
alter table public.work_orders add column if not exists priority text default 'normal';
alter table public.work_orders add column if not exists street text;
alter table public.work_orders add column if not exists city text;
alter table public.work_orders add column if not exists state text;
alter table public.work_orders add column if not exists zip_code text;
alter table public.work_orders add column if not exists latitude double precision;
alter table public.work_orders add column if not exists longitude double precision;
alter table public.work_orders add column if not exists status text default 'new';
alter table public.work_orders add column if not exists scheduled_for timestamptz;
alter table public.work_orders add column if not exists technician_eta_at timestamptz;
alter table public.work_orders add column if not exists assigned_technician_id uuid;
alter table public.work_orders add column if not exists ai_analysis jsonb;
alter table public.work_orders add column if not exists document_type text default 'work_order';
alter table public.work_orders add column if not exists external_id text;
alter table public.work_orders add column if not exists job_type text;
alter table public.work_orders add column if not exists commitment_at timestamptz;
alter table public.work_orders add column if not exists record_type text;
alter table public.work_orders add column if not exists alert_status text;
alter table public.work_orders add column if not exists special_handling text;
alter table public.work_orders add column if not exists region text;
alter table public.work_orders add column if not exists timezone text;
alter table public.work_orders add column if not exists wrid text;
alter table public.work_orders add column if not exists location_contact text;
alter table public.work_orders add column if not exists contact_number text;
alter table public.work_orders add column if not exists turf text;
alter table public.work_orders add column if not exists requester text;
alter table public.work_orders add column if not exists noc_phone text;
alter table public.work_orders add column if not exists client_name text;
alter table public.work_orders add column if not exists store_name text;
alter table public.work_orders add column if not exists store_number text;
alter table public.work_orders add column if not exists full_address text;
alter table public.work_orders add column if not exists nte numeric(12,2);
alter table public.work_orders add column if not exists currency text default 'USD';
alter table public.work_orders add column if not exists eta_code text;
alter table public.work_orders add column if not exists requested_arrival_at timestamptz;
alter table public.work_orders add column if not exists special_instructions text;
alter table public.work_orders add column if not exists problem_summary text;
alter table public.work_orders add column if not exists follow_up_tag text default 'New';
alter table public.work_orders add column if not exists quote_text text;
alter table public.work_orders add column if not exists payment_request_text text;
alter table public.work_orders add column if not exists best_contact text;
alter table public.work_orders add column if not exists best_contact_phone text;
alter table public.work_orders add column if not exists sow text;
alter table public.work_orders add column if not exists extracted_fields jsonb default '{}'::jsonb;
alter table public.work_orders add column if not exists workflow_stage text default 'new_hiring';
alter table public.work_orders add column if not exists stage_updated_at timestamptz default now();
alter table public.work_orders add column if not exists actual_arrival_at timestamptz;
alter table public.work_orders add column if not exists approved_quote_total numeric(12,2);
alter table public.work_orders add column if not exists work_scheduled_for timestamptz;
alter table public.work_orders add column if not exists work_started_at timestamptz;
alter table public.work_orders add column if not exists work_done_at timestamptz;
alter table public.work_orders add column if not exists created_at timestamptz default now();
alter table public.work_orders add column if not exists updated_at timestamptz default now();

-- Preserve closed legacy WOs; active legacy statuses enter the new Hiring flow.
update public.work_orders set workflow_stage='work_done' where status='completed';
update public.work_orders set workflow_stage=status
where status in ('new_hiring','en_route','arrived','diagnosis','pending_approval','approved','work_in_progress','work_done','cancelled');

create index if not exists idx_wo_status  on public.work_orders (status);
create index if not exists idx_wo_trade   on public.work_orders (trade);
create index if not exists idx_wo_created on public.work_orders (created_at desc);

-- ---------------------------------------------------------------------------
-- APP SETTINGS (model only; company rules live in ai-assist)
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  id                 text primary key default 'default',
  openai_model       text default 'gpt-5.4-mini',
  training_revision  text default 'MDAMA-Jayco-v7-workflow',
  updated_at         timestamptz default now()
);
alter table public.app_settings add column if not exists openai_model text default 'gpt-5.4-mini';
alter table public.app_settings add column if not exists training_revision text default 'MDAMA-Jayco-v7-workflow';
alter table public.app_settings add column if not exists updated_at timestamptz default now();
insert into public.app_settings (id) values ('default') on conflict (id) do nothing;
update public.app_settings set training_revision='MDAMA-Jayco-v7-workflow' where id='default';

-- ---------------------------------------------------------------------------
-- WORK ORDER DOCUMENTS (append-only quote/document versions)
-- ---------------------------------------------------------------------------
create table if not exists public.work_order_documents (
  id                 uuid primary key default gen_random_uuid(),
  work_order_id      uuid not null references public.work_orders(id) on delete cascade,
  document_type      text not null,
  version            integer,
  source             text default 'generated',
  content            text not null,
  structured_data    jsonb default '{}'::jsonb,
  created_at         timestamptz default now()
);
alter table public.work_order_documents add column if not exists work_order_id uuid;
alter table public.work_order_documents add column if not exists document_type text;
alter table public.work_order_documents add column if not exists version integer;
alter table public.work_order_documents add column if not exists source text default 'generated';
alter table public.work_order_documents add column if not exists content text;
alter table public.work_order_documents add column if not exists structured_data jsonb default '{}'::jsonb;
alter table public.work_order_documents add column if not exists created_at timestamptz default now();
create index if not exists idx_wo_documents on public.work_order_documents (work_order_id, document_type, created_at desc);

create or replace function public.number_work_order_document() returns trigger as $$
begin
  if new.version is null then
    select coalesce(max(version), 0) + 1 into new.version
    from public.work_order_documents
    where work_order_id = new.work_order_id and document_type = new.document_type;
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_number_work_order_document on public.work_order_documents;
create trigger trg_number_work_order_document before insert on public.work_order_documents
  for each row execute function public.number_work_order_document();

-- ---------------------------------------------------------------------------
-- WORKFLOW STAGE DATA (one durable JSON record per WO stage)
-- ---------------------------------------------------------------------------
create table if not exists public.work_order_stage_data (
  id             uuid primary key default gen_random_uuid(),
  work_order_id  uuid not null references public.work_orders(id) on delete cascade,
  stage          text not null,
  data           jsonb not null default '{}'::jsonb,
  completed      boolean not null default false,
  completed_at   timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  unique (work_order_id, stage)
);
alter table public.work_order_stage_data add column if not exists work_order_id uuid;
alter table public.work_order_stage_data add column if not exists stage text;
alter table public.work_order_stage_data add column if not exists data jsonb default '{}'::jsonb;
alter table public.work_order_stage_data add column if not exists completed boolean default false;
alter table public.work_order_stage_data add column if not exists completed_at timestamptz;
alter table public.work_order_stage_data add column if not exists created_at timestamptz default now();
alter table public.work_order_stage_data add column if not exists updated_at timestamptz default now();
create unique index if not exists idx_one_stage_row_per_wo on public.work_order_stage_data(work_order_id,stage);
create index if not exists idx_stage_rows_wo on public.work_order_stage_data(work_order_id,updated_at);

-- ---------------------------------------------------------------------------
-- WORKFLOW FILE INDEX (bytes live in the private wo-files Storage bucket)
-- ---------------------------------------------------------------------------
create table if not exists public.work_order_files (
  id             uuid primary key default gen_random_uuid(),
  work_order_id  uuid not null references public.work_orders(id) on delete cascade,
  stage          text not null,
  file_type      text not null,
  item_ref       text,
  storage_path   text not null unique,
  file_name      text not null,
  mime_type      text,
  size_bytes     bigint,
  created_at     timestamptz default now()
);
alter table public.work_order_files add column if not exists work_order_id uuid;
alter table public.work_order_files add column if not exists stage text;
alter table public.work_order_files add column if not exists file_type text;
alter table public.work_order_files add column if not exists item_ref text;
alter table public.work_order_files add column if not exists storage_path text;
alter table public.work_order_files add column if not exists file_name text;
alter table public.work_order_files add column if not exists mime_type text;
alter table public.work_order_files add column if not exists size_bytes bigint;
alter table public.work_order_files add column if not exists created_at timestamptz default now();
create index if not exists idx_wo_files_stage on public.work_order_files(work_order_id,stage,file_type);

-- ---------------------------------------------------------------------------
-- PAYMENT REQUESTS (many per WO; multiple requests remain allowed after Work Done)
-- ---------------------------------------------------------------------------
create table if not exists public.payment_requests (
  id                 uuid primary key default gen_random_uuid(),
  work_order_id      uuid not null references public.work_orders(id) on delete cascade,
  sequence_number    integer,
  request_date       date default current_date,
  status             text not null,
  status_note        text,
  nte                numeric(12,2),
  amount_due         numeric(12,2) default 0,
  incurred           numeric(12,2) default 0,
  total_cost         numeric(12,2) default 0,
  payment_method     text,
  trade              text,
  technician_name    text,
  technician_phone   text,
  store_name         text,
  address            text,
  dispatcher         text,
  team_leader        text,
  company_name       text default 'Jayco',
  content            text,
  source_text        text,
  structured_data    jsonb default '{}'::jsonb,
  is_final           boolean default false,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
alter table public.payment_requests add column if not exists work_order_id uuid;
alter table public.payment_requests add column if not exists sequence_number integer;
alter table public.payment_requests add column if not exists request_date date default current_date;
alter table public.payment_requests add column if not exists status text;
alter table public.payment_requests add column if not exists status_note text;
alter table public.payment_requests add column if not exists nte numeric(12,2);
alter table public.payment_requests add column if not exists amount_due numeric(12,2) default 0;
alter table public.payment_requests add column if not exists incurred numeric(12,2) default 0;
alter table public.payment_requests add column if not exists total_cost numeric(12,2) default 0;
alter table public.payment_requests add column if not exists payment_method text;
alter table public.payment_requests add column if not exists trade text;
alter table public.payment_requests add column if not exists technician_name text;
alter table public.payment_requests add column if not exists technician_phone text;
alter table public.payment_requests add column if not exists store_name text;
alter table public.payment_requests add column if not exists address text;
alter table public.payment_requests add column if not exists dispatcher text;
alter table public.payment_requests add column if not exists team_leader text;
alter table public.payment_requests add column if not exists company_name text default 'Jayco';
alter table public.payment_requests add column if not exists content text;
alter table public.payment_requests add column if not exists source_text text;
alter table public.payment_requests add column if not exists structured_data jsonb default '{}'::jsonb;
alter table public.payment_requests add column if not exists is_final boolean default false;
alter table public.payment_requests add column if not exists created_at timestamptz default now();
alter table public.payment_requests add column if not exists updated_at timestamptz default now();
create index if not exists idx_payment_requests_wo on public.payment_requests (work_order_id, sequence_number, created_at);
drop index if exists public.idx_one_final_payment_per_wo;
create index if not exists idx_payment_requests_status on public.payment_requests (work_order_id,status,created_at);

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

drop trigger if exists trg_close_wo_on_final_payment on public.payment_requests;

-- ---------------------------------------------------------------------------
-- WORK ORDER CANDIDATES  (ranked shortlist per WO)
-- ---------------------------------------------------------------------------
create table if not exists public.work_order_candidates (
  id                 uuid primary key default gen_random_uuid(),
  work_order_id      uuid not null references public.work_orders(id) on delete cascade,
  technician_id      uuid not null references public.technicians(id) on delete cascade,
  rank               integer,
  score              numeric,
  distance_miles     numeric,
  reason             text,
  outcome            text default 'shortlisted', -- shortlisted|contacted|responded|accepted|declined|assigned
  created_at         timestamptz default now(),
  unique (work_order_id, technician_id)
);
alter table public.work_order_candidates add column if not exists work_order_id uuid;
alter table public.work_order_candidates add column if not exists technician_id uuid;
alter table public.work_order_candidates add column if not exists rank integer;
alter table public.work_order_candidates add column if not exists score numeric;
alter table public.work_order_candidates add column if not exists distance_miles numeric;
alter table public.work_order_candidates add column if not exists reason text;
alter table public.work_order_candidates add column if not exists outcome text default 'shortlisted';
alter table public.work_order_candidates add column if not exists created_at timestamptz default now();
create index if not exists idx_cand_wo on public.work_order_candidates (work_order_id);

-- ---------------------------------------------------------------------------
-- STATUS HISTORY
-- ---------------------------------------------------------------------------
create table if not exists public.work_order_status_history (
  id             uuid primary key default gen_random_uuid(),
  work_order_id  uuid not null references public.work_orders(id) on delete cascade,
  from_status    text,
  to_status      text,
  note           text,
  created_at     timestamptz default now()
);
alter table public.work_order_status_history add column if not exists work_order_id uuid;
alter table public.work_order_status_history add column if not exists from_status text;
alter table public.work_order_status_history add column if not exists to_status text;
-- Older MDAMA installations used old_status/new_status and may still enforce
-- NOT NULL on new_status. Keep both naming conventions populated so a status
-- change never fails after Hiring.
alter table public.work_order_status_history add column if not exists old_status text;
alter table public.work_order_status_history add column if not exists new_status text;
alter table public.work_order_status_history add column if not exists note text;
alter table public.work_order_status_history add column if not exists created_at timestamptz default now();
create index if not exists idx_hist_wo on public.work_order_status_history (work_order_id, created_at desc);

-- ---------------------------------------------------------------------------
-- TECHNICIAN INTERACTIONS  (audit log of every touch)
-- ---------------------------------------------------------------------------
create table if not exists public.technician_interactions (
  id              uuid primary key default gen_random_uuid(),
  technician_id   uuid not null references public.technicians(id) on delete cascade,
  work_order_id   uuid references public.work_orders(id) on delete set null,
  interaction_type text,  -- contacted|responded|accepted|completed|declined|vendor_marked|vendor_unmarked
  channel         text,   -- phone|sms|email|manual
  note            text,
  created_at      timestamptz default now()
);
alter table public.technician_interactions add column if not exists technician_id uuid;
alter table public.technician_interactions add column if not exists work_order_id uuid;
alter table public.technician_interactions add column if not exists interaction_type text;
alter table public.technician_interactions add column if not exists channel text;
alter table public.technician_interactions add column if not exists note text;
alter table public.technician_interactions add column if not exists created_at timestamptz default now();
create index if not exists idx_inter_tech on public.technician_interactions (technician_id, created_at desc);

-- ---------------------------------------------------------------------------
-- CLASSIFICATION HISTORY  (vendor / trade changes)
-- ---------------------------------------------------------------------------
create table if not exists public.technician_classification_history (
  id             uuid primary key default gen_random_uuid(),
  technician_id  uuid not null references public.technicians(id) on delete cascade,
  field          text,
  old_value      text,
  new_value      text,
  created_at     timestamptz default now()
);
alter table public.technician_classification_history add column if not exists technician_id uuid;
alter table public.technician_classification_history add column if not exists field text;
alter table public.technician_classification_history add column if not exists old_value text;
alter table public.technician_classification_history add column if not exists new_value text;
alter table public.technician_classification_history add column if not exists created_at timestamptz default now();

-- ---------------------------------------------------------------------------
-- ALERTS
-- ---------------------------------------------------------------------------
create table if not exists public.work_order_alerts (
  id             uuid primary key default gen_random_uuid(),
  work_order_id  uuid references public.work_orders(id) on delete cascade,
  level          text,  -- info|warn|critical
  message        text,
  resolved       boolean default false,
  created_at     timestamptz default now()
);
-- This guard fixes ERROR 42703 on projects where work_order_alerts already
-- exists from an older version without the `resolved` column.
alter table public.work_order_alerts add column if not exists work_order_id uuid;
alter table public.work_order_alerts add column if not exists level text;
alter table public.work_order_alerts add column if not exists message text;
alter table public.work_order_alerts add column if not exists resolved boolean default false;
alter table public.work_order_alerts add column if not exists created_at timestamptz default now();
create index if not exists idx_alert_open on public.work_order_alerts (resolved, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end $$ language plpgsql;

drop trigger if exists trg_tech_touch on public.technicians;
create trigger trg_tech_touch before update on public.technicians
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_wo_touch on public.work_orders;
create trigger trg_wo_touch before update on public.work_orders
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_payment_touch on public.payment_requests;
create trigger trg_payment_touch before update on public.payment_requests
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_stage_touch on public.work_order_stage_data;
create trigger trg_stage_touch before update on public.work_order_stage_data
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-log WO status changes
-- ---------------------------------------------------------------------------
create or replace function public.log_wo_status() returns trigger as $$
begin
  if (tg_op = 'UPDATE' and new.status is distinct from old.status) then
    insert into public.work_order_status_history
      (work_order_id, from_status, to_status, old_status, new_status)
    values
      (new.id, old.status, new.status, old.status, new.status);
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_wo_status on public.work_orders;
create trigger trg_wo_status after update on public.work_orders
  for each row execute function public.log_wo_status();

notify pgrst, 'reload schema';
commit;

-- ---------------------------------------------------------------------------
-- DEV MODE ACCESS (the current application intentionally runs without login)
-- ---------------------------------------------------------------------------
begin;
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'technicians','work_orders','work_order_candidates','work_order_status_history',
    'technician_interactions','technician_classification_history','work_order_alerts',
    'work_order_documents','payment_requests','work_order_stage_data','work_order_files'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists %I on public.%I', 'dev_anon_all_'||table_name, table_name);
    execute format(
      'create policy %I on public.%I for all to anon using (true) with check (true)',
      'dev_anon_all_'||table_name, table_name
    );
    execute format('grant select, insert, update, delete on public.%I to anon', table_name);
  end loop;
end $$;

alter table public.app_settings enable row level security;
drop policy if exists dev_anon_all_app_settings on public.app_settings;
create policy dev_anon_all_app_settings on public.app_settings
  for all to anon using (true) with check (true);
revoke all on public.app_settings from anon;
grant select (id, openai_model, training_revision, updated_at) on public.app_settings to anon;
grant update (openai_model) on public.app_settings to anon;
grant usage on schema public to anon;

-- Private Storage bucket. The current no-login app can access it through RLS,
-- but objects are not public URLs. The UI creates short-lived signed previews.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('wo-files','wo-files',false,12582912,null)
on conflict (id) do update set public=false,file_size_limit=12582912,
  allowed_mime_types=null;

drop policy if exists dev_anon_select_wo_files on storage.objects;
drop policy if exists dev_anon_insert_wo_files on storage.objects;
drop policy if exists dev_anon_update_wo_files on storage.objects;
drop policy if exists dev_anon_delete_wo_files on storage.objects;
create policy dev_anon_select_wo_files on storage.objects for select to anon using (bucket_id='wo-files');
create policy dev_anon_insert_wo_files on storage.objects for insert to anon with check (bucket_id='wo-files');
create policy dev_anon_update_wo_files on storage.objects for update to anon using (bucket_id='wo-files') with check (bucket_id='wo-files');
create policy dev_anon_delete_wo_files on storage.objects for delete to anon using (bucket_id='wo-files');

-- Force PostgREST to see payment_requests and every new WO column immediately.
notify pgrst, 'reload schema';
commit;
