-- ============================================================================
-- 30_multiuser_auth_foundation.sql  (RESTORED in v12.1)
--
-- index.html's header comment says:
--   "the publishable key alone (the old no-login model) no longer carries
--    write access under the RLS policies in sql/30_multiuser_auth_foundation.sql"
-- ...but that file was never shipped. Without it:
--   * public.profiles does not exist, so loadAuthProfile() always fails and
--     every signed-in user silently falls back to authProfile = null;
--   * RLS is OFF on every table, so the sb_publishable_* key that is hard-coded
--     in index.html grants anonymous read AND write over the entire database.
--
-- Run this LAST, after 00_RUN_THIS_FIRST.sql, 23_live_search_db_v11_19.sql and
-- 30_vendor_network_fast_hire.sql. Idempotent.
-- ============================================================================
begin;

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- PROFILES — one row per auth.users row, carries role + active flag
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  full_name     text,
  company_name  text,
  role          text not null default 'user',   -- 'user' | 'admin'
  active        boolean not null default true,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists company_name text;
alter table public.profiles add column if not exists role text default 'user';
alter table public.profiles add column if not exists active boolean default true;
alter table public.profiles add column if not exists created_at timestamptz default now();
alter table public.profiles add column if not exists updated_at timestamptz default now();

do $$ begin
  alter table public.profiles add constraint profiles_role_check check (role in ('user','admin'));
exception when duplicate_object then null; end $$;

create index if not exists idx_profiles_role on public.profiles (role) where role = 'admin';

-- Backfill a profile for every existing auth user so nobody is locked out.
insert into public.profiles (id, email)
select u.id, u.email from auth.users u
on conflict (id) do nothing;

-- New signups get a profile automatically.
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists trg_handle_new_auth_user on auth.users;
create trigger trg_handle_new_auth_user
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Helper predicates. SECURITY DEFINER + STABLE so policies can call them
-- without recursing into profiles' own RLS.
-- ---------------------------------------------------------------------------
create or replace function public.is_active_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active is true
  );
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active is true and p.role = 'admin'
  );
$$;

revoke all on function public.is_active_member() from public;
revoke all on function public.is_admin() from public;
grant execute on function public.is_active_member() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- PROFILES policies
--   * anyone signed in reads their own row (loadAuthProfile needs this)
--   * admins read and manage everyone
--   * NOBODY can self-promote: role/active changes are admin-only
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select_self  on public.profiles;
drop policy if exists profiles_select_admin on public.profiles;
drop policy if exists profiles_update_self  on public.profiles;
drop policy if exists profiles_admin_all    on public.profiles;

create policy profiles_select_self on public.profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_select_admin on public.profiles
  for select to authenticated using (public.is_admin());

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role   = (select p.role   from public.profiles p where p.id = auth.uid())
    and active = (select p.active from public.profiles p where p.id = auth.uid())
  );

create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Everything else: signed-in ACTIVE members get full access, anon gets none.
-- Loop only over tables that actually exist, so this file stays runnable no
-- matter which of the optional migrations have been applied.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  member_tables text[] := array[
    'technicians','work_orders','work_order_documents','work_order_stage_data',
    'work_order_files','payment_requests','work_order_candidates',
    'work_order_status_history','technician_interactions',
    'technician_classification_history','work_order_alerts',
    'wo_candidates_findclose','wo_candidates_external','company_techs',
    'quo_manual_routes','worked_with_technicians','yelp_search_results',
    'live_search_technicians','search_phone_exclusions',
    'vendors','vendor_technicians'
  ];
begin
  foreach t in array member_tables loop
    if to_regclass('public.' || t) is null then
      raise notice 'skipping %, table not present', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- drop any policy this migration previously created, then recreate
    execute format('drop policy if exists %I on public.%I', t || '_member_all', t);
    execute format('drop policy if exists %I on public.%I', t || '_anon_none',  t);

    execute format(
      'create policy %I on public.%I for all to authenticated '
      || 'using (public.is_active_member()) with check (public.is_active_member())',
      t || '_member_all', t
    );

    -- make sure the anon role cannot reach the table even if a stray
    -- permissive grant exists from the pre-auth (no-login) era
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- APP SETTINGS — readable by any active member, writable by admins only
-- ---------------------------------------------------------------------------
alter table public.app_settings enable row level security;
drop policy if exists app_settings_read  on public.app_settings;
drop policy if exists app_settings_admin on public.app_settings;

create policy app_settings_read on public.app_settings
  for select to authenticated using (public.is_active_member());
create policy app_settings_admin on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.app_settings from anon;
grant select on public.app_settings to authenticated;
grant insert, update, delete on public.app_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Private Storage bucket used by the workflow file index
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('wo-files', 'wo-files', false)
on conflict (id) do update set public = false;

drop policy if exists wo_files_member_all on storage.objects;
create policy wo_files_member_all on storage.objects
  for all to authenticated
  using (bucket_id = 'wo-files' and public.is_active_member())
  with check (bucket_id = 'wo-files' and public.is_active_member());

commit;

-- ============================================================================
-- AFTER RUNNING THIS FILE
--
-- 1. Promote your own account to admin, or nobody can manage users:
--      update public.profiles set role = 'admin', active = true
--       where email = 'you@yourcompany.com';
--
-- 2. The five Edge Functions still use verify_jwt = false and accept the
--    PUBLIC sb_publishable_* key as their only credential. RLS does not
--    protect them, because they call the database with the SERVICE_ROLE key.
--    Set verify_jwt = true in supabase/config.toml and have each function
--    validate the caller's JWT instead of the apikey header.
--
-- 3. index.html also calls fn('admin-users', ...) for the user-management tab,
--    but supabase/functions/admin-users/ does not exist in this package. The
--    Users tab will keep failing until that function is written and deployed.
-- ============================================================================
