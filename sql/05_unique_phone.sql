-- ============================================================================
-- 05_unique_phone.sql
-- Makes normalized_phone the stable UPSERT key used by CSV imports.
-- Existing duplicates are consolidated without dropping WO assignments,
-- candidate history, interactions, or classification history.
-- Safe to re-run.
-- ============================================================================
begin;

alter table public.technicians
  add column if not exists facebook_url text;

-- Normalize existing values first. Unusable values become NULL so they do not
-- block the unique constraint and can be repaired later.
update public.technicians
set normalized_phone = case
  when length(regexp_replace(coalesce(nullif(normalized_phone, ''), phone, ''), '\\D', '', 'g')) = 11
   and regexp_replace(coalesce(nullif(normalized_phone, ''), phone, ''), '\\D', '', 'g') like '1%'
    then right(regexp_replace(coalesce(nullif(normalized_phone, ''), phone, ''), '\\D', '', 'g'), 10)
  when length(regexp_replace(coalesce(nullif(normalized_phone, ''), phone, ''), '\\D', '', 'g')) = 10
    then regexp_replace(coalesce(nullif(normalized_phone, ''), phone, ''), '\\D', '', 'g')
  else null
end
where normalized_phone is distinct from case
  when length(regexp_replace(coalesce(nullif(normalized_phone, ''), phone, ''), '\\D', '', 'g')) = 11
   and regexp_replace(coalesce(nullif(normalized_phone, ''), phone, ''), '\\D', '', 'g') like '1%'
    then right(regexp_replace(coalesce(nullif(normalized_phone, ''), phone, ''), '\\D', '', 'g'), 10)
  when length(regexp_replace(coalesce(nullif(normalized_phone, ''), phone, ''), '\\D', '', 'g')) = 10
    then regexp_replace(coalesce(nullif(normalized_phone, ''), phone, ''), '\\D', '', 'g')
  else null
end;

-- Work only with usable normalized phones. Rows without one remain separate;
-- PostgreSQL permits multiple NULLs in a regular UNIQUE constraint.
create temporary table mdama_phone_merge_map on commit drop as
with ranked as (
  select
    id,
    normalized_phone,
    row_number() over (
      partition by normalized_phone
      order by
        -- Keep the most complete profile as the canonical row.
        num_nonnulls(
          name, business_name, contact_owner, email, primary_trade, city, state,
          zip_code, latitude, longitude, rating, source_platform, source_url, facebook_url, notes
        ) desc,
        updated_at desc nulls last,
        created_at asc nulls last,
        id asc
    ) as rn
  from public.technicians
  where normalized_phone ~ '^[0-9]{10}$'
), keepers as (
  select normalized_phone, id as keeper_id
  from ranked
  where rn = 1
)
select r.id as duplicate_id, k.keeper_id
from ranked r
join keepers k using (normalized_phone)
where r.rn > 1;

-- Preserve the assigned technician on every WO.
update public.work_orders w
set assigned_technician_id = m.keeper_id
from mdama_phone_merge_map m
where w.assigned_technician_id = m.duplicate_id;

-- A WO may already contain both the canonical and duplicate technician. Merge
-- the useful shortlist values into the canonical candidate before removing the
-- conflicting duplicate candidate row.
with merged as (
  select
    d.work_order_id,
    m.keeper_id,
    min(d.rank) as best_rank,
    min(d.score) as best_score,
    min(d.distance_miles) as best_distance,
    (array_agg(d.reason order by d.created_at desc)
      filter (where d.reason is not null and d.reason <> ''))[1] as latest_reason,
    (array_agg(d.outcome order by
      case d.outcome
        when 'assigned' then 6 when 'accepted' then 5 when 'responded' then 4
        when 'contacted' then 3 when 'shortlisted' then 2 when 'declined' then 1
        else 0 end desc,
      d.created_at desc))[1] as strongest_outcome
  from public.work_order_candidates d
  join mdama_phone_merge_map m on m.duplicate_id = d.technician_id
  join public.work_order_candidates k
    on k.work_order_id = d.work_order_id and k.technician_id = m.keeper_id
  group by d.work_order_id, m.keeper_id
)
update public.work_order_candidates k
set rank = least(k.rank, merged.best_rank),
    score = least(k.score, merged.best_score),
    distance_miles = least(k.distance_miles, merged.best_distance),
    reason = coalesce(merged.latest_reason, k.reason),
    outcome = coalesce(merged.strongest_outcome, k.outcome)
from merged
where k.work_order_id = merged.work_order_id
  and k.technician_id = merged.keeper_id;

delete from public.work_order_candidates d
using mdama_phone_merge_map m, public.work_order_candidates k
where d.technician_id = m.duplicate_id
  and k.work_order_id = d.work_order_id
  and k.technician_id = m.keeper_id;

update public.work_order_candidates c
set technician_id = m.keeper_id
from mdama_phone_merge_map m
where c.technician_id = m.duplicate_id;

update public.technician_interactions i
set technician_id = m.keeper_id
from mdama_phone_merge_map m
where i.technician_id = m.duplicate_id;

update public.technician_classification_history h
set technician_id = m.keeper_id
from mdama_phone_merge_map m
where h.technician_id = m.duplicate_id;

delete from public.technicians t
using mdama_phone_merge_map m
where t.id = m.duplicate_id;

alter table public.technicians
  drop constraint if exists technicians_normalized_phone_key;
alter table public.technicians
  add constraint technicians_normalized_phone_key unique (normalized_phone);

-- Server-side merge used by the Edge Function. Missing optional CSV values do
-- not erase richer data already stored for the same technician.
create or replace function public.import_technicians_batch(p_state text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer;
  allowed_states constant text[] := array[
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC'
  ];
begin
  p_state := upper(trim(p_state));
  if not (p_state = any(allowed_states)) then
    raise exception 'Unsupported US state code: %', p_state;
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows must be a non-empty JSON array';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'Maximum 5000 rows per import';
  end if;

  with source as (
    select *
    from jsonb_to_recordset(p_rows) as r(
      name text,
      business_name text,
      contact_owner text,
      phone text,
      normalized_phone text,
      email text,
      primary_trade text,
      city text,
      zip_code text,
      latitude double precision,
      longitude double precision,
      rating numeric,
      reviews_count integer,
      is_vendor boolean,
      is_external boolean,
      active boolean,
      source_type text,
      source_platform text,
      source_url text,
      facebook_url text,
      notes text
    )
  )
  merge into public.technicians as t
  using (
    select * from source where normalized_phone ~ '^[0-9]{10}$'
  ) as s
  on t.normalized_phone = s.normalized_phone
  when matched then update set
    name = coalesce(s.name, t.name),
    business_name = coalesce(s.business_name, t.business_name),
    contact_owner = coalesce(s.contact_owner, t.contact_owner),
    phone = coalesce(s.phone, t.phone),
    email = coalesce(s.email, t.email),
    primary_trade = coalesce(s.primary_trade, t.primary_trade),
    city = coalesce(s.city, t.city),
    state = p_state,
    zip_code = coalesce(s.zip_code, t.zip_code),
    latitude = coalesce(s.latitude, t.latitude),
    longitude = coalesce(s.longitude, t.longitude),
    rating = coalesce(s.rating, t.rating),
    reviews_count = coalesce(s.reviews_count, t.reviews_count),
    is_vendor = coalesce(s.is_vendor, t.is_vendor),
    is_external = coalesce(s.is_external, t.is_external),
    active = coalesce(s.active, t.active),
    source_type = coalesce(s.source_type, t.source_type),
    source_platform = coalesce(s.source_platform, t.source_platform),
    source_url = coalesce(s.source_url, t.source_url),
    facebook_url = coalesce(s.facebook_url, t.facebook_url),
    notes = coalesce(s.notes, t.notes),
    updated_at = now()
  when not matched then insert (
    name, business_name, contact_owner, phone, normalized_phone, email,
    primary_trade, city, state, zip_code, latitude, longitude, rating,
    reviews_count, is_vendor, is_external, active, source_type,
    source_platform, source_url, facebook_url, notes
  ) values (
    s.name, s.business_name, s.contact_owner, s.phone, s.normalized_phone, s.email,
    s.primary_trade, s.city, p_state, s.zip_code, s.latitude, s.longitude, s.rating,
    coalesce(s.reviews_count, 0), coalesce(s.is_vendor, false),
    coalesce(s.is_external, false), coalesce(s.active, true), s.source_type,
    s.source_platform, s.source_url, s.facebook_url, s.notes
  );

  get diagnostics affected = row_count;

  return affected;
end;
$$;

revoke all on function public.import_technicians_batch(text, jsonb) from public, anon, authenticated;
grant execute on function public.import_technicians_batch(text, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
