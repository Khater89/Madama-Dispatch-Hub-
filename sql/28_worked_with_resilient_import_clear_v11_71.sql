-- MDAMA Dispatch v11.71
-- Resilient Worked With batch import + reliable table clear.
-- Safe / idempotent. Run after 27_worked_with_smart_import_v11_68.sql.

begin;

create or replace function public.import_worked_with_batch_v2(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  v_phone text;
  v_email text;
  phone_id uuid;
  email_id uuid;
  existing_id uuid;
  other_row public.worked_with_technicians%rowtype;
  v_job_count integer;
  n_inserted integer := 0;
  n_updated integer := 0;
  n_skipped integer := 0;
  n_failed integer := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  for r in select value from jsonb_array_elements(p_rows)
  loop
    begin
      v_phone := regexp_replace(coalesce(r->>'normalized_phone', r->>'phone', ''), '\D', '', 'g');
      if length(v_phone)=11 and left(v_phone,1)='1' then v_phone := substr(v_phone,2); end if;
      if length(v_phone)<>10 then v_phone := null; end if;
      v_email := nullif(lower(btrim(coalesce(r->>'email',''))),'');

      -- Phone is the authoritative required identity in v11.71.
      if v_phone is null then
        n_skipped := n_skipped + 1;
        continue;
      end if;

      phone_id := null;
      email_id := null;
      select id into phone_id
      from public.worked_with_technicians
      where normalized_phone = v_phone
      order by updated_at desc nulls last, created_at desc nulls last
      limit 1;

      if v_email is not null then
        select id into email_id
        from public.worked_with_technicians
        where lower(email) = v_email
        order by updated_at desc nulls last, created_at desc nulls last
        limit 1;
      end if;

      -- If phone and email accidentally point at two historical rows, merge them
      -- into the phone row instead of aborting the entire imported file.
      if phone_id is not null and email_id is not null and phone_id <> email_id then
        select * into other_row from public.worked_with_technicians where id=email_id;
        delete from public.worked_with_technicians where id=email_id;
        update public.worked_with_technicians t set
          technician_id = coalesce(t.technician_id, other_row.technician_id),
          name = coalesce(t.name, other_row.name),
          business_name = coalesce(t.business_name, other_row.business_name),
          email = coalesce(t.email, other_row.email),
          primary_trade = coalesce(t.primary_trade, other_row.primary_trade),
          city = coalesce(t.city, other_row.city),
          state = coalesce(t.state, other_row.state),
          zip_code = coalesce(t.zip_code, other_row.zip_code),
          latitude = coalesce(t.latitude, other_row.latitude),
          longitude = coalesce(t.longitude, other_row.longitude),
          hourly_rate = coalesce(t.hourly_rate, other_row.hourly_rate),
          helper_rate = coalesce(t.helper_rate, other_row.helper_rate),
          assessment_fee = coalesce(t.assessment_fee, other_row.assessment_fee),
          total_amount = coalesce(t.total_amount, other_row.total_amount),
          job_count = greatest(coalesce(t.job_count,0), coalesce(other_row.job_count,0)),
          payment_method = coalesce(t.payment_method, other_row.payment_method),
          payment_details = coalesce(t.payment_details, other_row.payment_details),
          notes = coalesce(t.notes, other_row.notes),
          source_name = coalesce(t.source_name, other_row.source_name),
          raw_data = coalesce(t.raw_data,'{}'::jsonb) || coalesce(other_row.raw_data,'{}'::jsonb),
          last_used_at = greatest(t.last_used_at, other_row.last_used_at),
          updated_at = now()
        where t.id=phone_id;
        email_id := phone_id;
      end if;

      -- Phone is primary. An email-only match may be reused only when that
      -- historical row has no phone (or already has this same phone).
      if phone_id is null and email_id is not null then
        if exists (select 1 from public.worked_with_technicians where id=email_id and normalized_phone is not null and btrim(normalized_phone)<>'' and normalized_phone<>v_phone) then
          email_id := null;
          v_email := null; -- preserve the existing email owner; import this phone as a separate tech
        end if;
      end if;

      existing_id := coalesce(phone_id,email_id);
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
          normalized_phone = v_phone,
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
    exception when others then
      n_failed := n_failed + 1;
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'phone', coalesce(r->>'phone', r->>'normalized_phone', ''),
        'email', coalesce(r->>'email',''),
        'error', SQLERRM
      ));
      -- Continue with the next technician instead of rolling back the whole batch.
    end;
  end loop;

  return jsonb_build_object(
    'inserted',n_inserted,
    'updated',n_updated,
    'skipped',n_skipped,
    'failed',n_failed,
    'errors',v_errors,
    'total',n_inserted+n_updated+n_skipped+n_failed
  );
end $$;

create or replace function public.clear_worked_with_technicians()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_deleted bigint := 0;
begin
  delete from public.worked_with_technicians;
  get diagnostics n_deleted = row_count;
  return jsonb_build_object('deleted',n_deleted);
end $$;

grant execute on function public.import_worked_with_batch_v2(jsonb) to anon, authenticated;
grant execute on function public.clear_worked_with_technicians() to anon, authenticated;

grant select, insert, update, delete on public.worked_with_technicians to anon, authenticated;

commit;
