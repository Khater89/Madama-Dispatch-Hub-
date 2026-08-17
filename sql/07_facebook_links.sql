-- ==========================================================================
-- 07_facebook_links.sql
-- Keeps Facebook URLs separate from the generic source URL so technicians
-- found on more than one platform never lose their Facebook link.
-- Safe to re-run.
-- ==========================================================================
begin;

alter table public.technicians
  add column if not exists facebook_url text;

-- Backfill every technician whose primary source URL is already Facebook.
update public.technicians
set facebook_url = source_url
where coalesce(facebook_url, '') = ''
  and source_url ~* '^https?://(www\.)?(facebook\.com|fb\.com)/';

-- Recover Facebook URLs that were stored as alternate-source notes.
update public.technicians
set facebook_url = substring(
  coalesce(notes, '') from 'https?://[^[:space:]|]*facebook\.com/[^[:space:]|]+'
)
where coalesce(facebook_url, '') = ''
  and coalesce(notes, '') ~* 'https?://[^[:space:]|]*facebook\.com/';

-- Three multi-source records in the current processed dataset had their
-- alternate link removed from the compact database note during an older merge.
update public.technicians set facebook_url = 'https://www.facebook.com/groups/589706948344335/posts/2150486985599649/'
where normalized_phone = '2568364855';
update public.technicians set facebook_url = 'https://www.facebook.com/AZCrystalclearpressurewashing/'
where normalized_phone = '6232628898';
update public.technicians set facebook_url = 'https://www.facebook.com/groups/1090928247933683/posts/1337374616622377/'
where normalized_phone = '4156996085';
update public.technicians set facebook_url = 'https://www.facebook.com/groups/1418308391734873/posts/4153058064926545/'
where normalized_phone = '8608766019';

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
