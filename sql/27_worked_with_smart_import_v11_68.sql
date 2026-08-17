-- MDAMA Dispatch v11.68 — Worked With technicians + Smart Import ETL
-- Safe / idempotent. Run once in Supabase SQL Editor.
begin;

create extension if not exists "pgcrypto";

create table if not exists public.worked_with_technicians (
  id                uuid primary key default gen_random_uuid(),
  technician_id     uuid references public.technicians(id) on delete set null,
  name              text,
  business_name     text,
  phone             text,
  normalized_phone  text,
  email             text,
  primary_trade     text,
  city              text,
  state             text,
  zip_code          text,
  latitude          double precision,
  longitude         double precision,
  hourly_rate       numeric(12,2),
  helper_rate       numeric(12,2),
  assessment_fee    numeric(12,2),
  total_amount      numeric(12,2),
  job_count         integer not null default 0,
  payment_method    text,
  payment_details   text,
  notes             text,
  source_name       text,
  raw_data          jsonb not null default '{}'::jsonb,
  last_used_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.worked_with_technicians add column if not exists technician_id uuid references public.technicians(id) on delete set null;
alter table public.worked_with_technicians add column if not exists name text;
alter table public.worked_with_technicians add column if not exists business_name text;
alter table public.worked_with_technicians add column if not exists phone text;
alter table public.worked_with_technicians add column if not exists normalized_phone text;
alter table public.worked_with_technicians add column if not exists email text;
alter table public.worked_with_technicians add column if not exists primary_trade text;
alter table public.worked_with_technicians add column if not exists city text;
alter table public.worked_with_technicians add column if not exists state text;
alter table public.worked_with_technicians add column if not exists zip_code text;
alter table public.worked_with_technicians add column if not exists latitude double precision;
alter table public.worked_with_technicians add column if not exists longitude double precision;
alter table public.worked_with_technicians add column if not exists hourly_rate numeric(12,2);
alter table public.worked_with_technicians add column if not exists helper_rate numeric(12,2);
alter table public.worked_with_technicians add column if not exists assessment_fee numeric(12,2);
alter table public.worked_with_technicians add column if not exists total_amount numeric(12,2);
alter table public.worked_with_technicians add column if not exists job_count integer default 0;
alter table public.worked_with_technicians add column if not exists payment_method text;
alter table public.worked_with_technicians add column if not exists payment_details text;
alter table public.worked_with_technicians add column if not exists notes text;
alter table public.worked_with_technicians add column if not exists source_name text;
alter table public.worked_with_technicians add column if not exists raw_data jsonb default '{}'::jsonb;
alter table public.worked_with_technicians add column if not exists last_used_at timestamptz;
alter table public.worked_with_technicians add column if not exists created_at timestamptz default now();
alter table public.worked_with_technicians add column if not exists updated_at timestamptz default now();

update public.worked_with_technicians set job_count=0 where job_count is null or job_count < 0;

create index if not exists idx_worked_with_city_state on public.worked_with_technicians(state, city);
create index if not exists idx_worked_with_trade on public.worked_with_technicians(primary_trade);
create index if not exists idx_worked_with_zip on public.worked_with_technicians(zip_code);
create index if not exists idx_worked_with_technician on public.worked_with_technicians(technician_id);
create unique index if not exists ux_worked_with_phone
  on public.worked_with_technicians(normalized_phone)
  where normalized_phone is not null and btrim(normalized_phone) <> '';
create unique index if not exists ux_worked_with_email
  on public.worked_with_technicians(lower(email))
  where email is not null and btrim(email) <> '';

-- Browser ETL sends already-normalized rows. This RPC performs the authoritative
-- Phone OR Email merge so irregular imports never create duplicates.
create or replace function public.import_worked_with_batch(p_rows jsonb)
returns jsonb
language plpgsql
as $$
declare
  r jsonb;
  existing_id uuid;
  v_phone text;
  v_email text;
  n_inserted integer := 0;
  n_updated integer := 0;
  n_skipped integer := 0;
  v_job_count integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  for r in select value from jsonb_array_elements(p_rows)
  loop
    v_phone := regexp_replace(coalesce(r->>'normalized_phone', r->>'phone', ''), '\D', '', 'g');
    if length(v_phone)=11 and left(v_phone,1)='1' then v_phone := substr(v_phone,2); end if;
    if length(v_phone)<>10 then v_phone := null; end if;
    v_email := nullif(lower(btrim(coalesce(r->>'email',''))),'');

    if v_phone is null and v_email is null then
      n_skipped := n_skipped + 1;
      continue;
    end if;

    existing_id := null;
    select id into existing_id
    from public.worked_with_technicians
    where (v_phone is not null and normalized_phone=v_phone)
       or (v_email is not null and lower(email)=v_email)
    order by updated_at desc nulls last, created_at desc nulls last
    limit 1;

    begin
      v_job_count := greatest(0, coalesce(nullif(regexp_replace(coalesce(r->>'job_count',''), '[^0-9-]', '', 'g'),'')::integer,0));
    exception when others then
      v_job_count := 0;
    end;

    if existing_id is not null then
      update public.worked_with_technicians t set
        name = coalesce(nullif(btrim(r->>'name'),''), t.name),
        business_name = coalesce(nullif(btrim(r->>'business_name'),''), t.business_name),
        phone = coalesce(nullif(btrim(r->>'phone'),''), t.phone),
        normalized_phone = coalesce(v_phone, t.normalized_phone),
        email = coalesce(v_email, t.email),
        primary_trade = coalesce(nullif(btrim(r->>'primary_trade'),''), t.primary_trade),
        city = coalesce(nullif(btrim(r->>'city'),''), t.city),
        state = coalesce(nullif(upper(btrim(r->>'state')),''), t.state),
        zip_code = coalesce(nullif(btrim(r->>'zip_code'),''), t.zip_code),
        latitude = coalesce(case when nullif(r->>'latitude','') is not null then (r->>'latitude')::double precision end, t.latitude),
        longitude = coalesce(case when nullif(r->>'longitude','') is not null then (r->>'longitude')::double precision end, t.longitude),
        hourly_rate = coalesce(case when nullif(r->>'hourly_rate','') is not null then (r->>'hourly_rate')::numeric end, t.hourly_rate),
        helper_rate = coalesce(case when nullif(r->>'helper_rate','') is not null then (r->>'helper_rate')::numeric end, t.helper_rate),
        assessment_fee = coalesce(case when nullif(r->>'assessment_fee','') is not null then (r->>'assessment_fee')::numeric end, t.assessment_fee),
        total_amount = coalesce(case when nullif(r->>'total_amount','') is not null then (r->>'total_amount')::numeric end, t.total_amount),
        job_count = greatest(coalesce(t.job_count,0), v_job_count),
        payment_method = coalesce(nullif(btrim(r->>'payment_method'),''), t.payment_method),
        payment_details = coalesce(nullif(btrim(r->>'payment_details'),''), t.payment_details),
        notes = coalesce(nullif(btrim(r->>'notes'),''), t.notes),
        source_name = coalesce(nullif(btrim(r->>'source_name'),''), t.source_name),
        raw_data = case when r ? 'raw_data' then coalesce(r->'raw_data','{}'::jsonb) else t.raw_data end,
        updated_at = now()
      where t.id=existing_id;
      n_updated := n_updated + 1;
    else
      insert into public.worked_with_technicians(
        name,business_name,phone,normalized_phone,email,primary_trade,city,state,zip_code,
        latitude,longitude,hourly_rate,helper_rate,assessment_fee,total_amount,job_count,
        payment_method,payment_details,notes,source_name,raw_data,updated_at
      ) values (
        nullif(btrim(r->>'name'),''),nullif(btrim(r->>'business_name'),''),nullif(btrim(r->>'phone'),''),v_phone,v_email,
        nullif(btrim(r->>'primary_trade'),''),nullif(btrim(r->>'city'),''),nullif(upper(btrim(r->>'state')),''),nullif(btrim(r->>'zip_code'),''),
        case when nullif(r->>'latitude','') is not null then (r->>'latitude')::double precision end,
        case when nullif(r->>'longitude','') is not null then (r->>'longitude')::double precision end,
        case when nullif(r->>'hourly_rate','') is not null then (r->>'hourly_rate')::numeric end,
        case when nullif(r->>'helper_rate','') is not null then (r->>'helper_rate')::numeric end,
        case when nullif(r->>'assessment_fee','') is not null then (r->>'assessment_fee')::numeric end,
        case when nullif(r->>'total_amount','') is not null then (r->>'total_amount')::numeric end,
        v_job_count,nullif(btrim(r->>'payment_method'),''),nullif(btrim(r->>'payment_details'),''),nullif(btrim(r->>'notes'),''),
        nullif(btrim(r->>'source_name'),''),coalesce(r->'raw_data','{}'::jsonb),now()
      );
      n_inserted := n_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('inserted',n_inserted,'updated',n_updated,'skipped',n_skipped,'total',n_inserted+n_updated+n_skipped);
end $$;

alter table public.worked_with_technicians enable row level security;
drop policy if exists dev_anon_all_worked_with_technicians on public.worked_with_technicians;
create policy dev_anon_all_worked_with_technicians on public.worked_with_technicians
  for all to anon using (true) with check (true);
grant select, insert, update, delete on public.worked_with_technicians to anon;
grant execute on function public.import_worked_with_batch(jsonb) to anon;
grant usage on schema public to anon;

notify pgrst, 'reload schema';
commit;
