-- ============================================================================
-- 04_state_views.sql
-- Creates one lightweight VIEW per US state and DC on top of the technicians
-- table. Each view acts like a "state table" but stays in sync automatically,
-- shares indexes, and never duplicates data.
-- Run AFTER 00_RUN_THIS_FIRST.sql. Safe to re-run.
-- ============================================================================
begin;

do $$
declare
  s text;
  states text[] := array[
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC'
  ];
begin
  foreach s in array states loop
    execute format(
      'create or replace view public.technicians_%s
         with (security_invoker = true) as
         select * from public.technicians where upper(state) = %L',
      lower(s), s
    );
    execute format('grant select on public.technicians_%s to anon', lower(s));
  end loop;
end $$;

commit;

-- Usage:
--   select * from technicians_la;            -- Louisiana only
--   select count(*) from technicians_ne;     -- Nebraska count
--   To search across all states, still use the base table:
--     select * from technicians where state = 'LA';
