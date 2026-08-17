-- MDAMA v11.4 optional recovery.
-- Only re-activates saved Tech Map rows when the table has records but ZERO active rows.
do $$
begin
  if exists (select 1 from public.company_techs)
     and not exists (select 1 from public.company_techs where coalesce(active,true)=true) then
    update public.company_techs
       set active=true,
           updated_at=now();
  end if;
end $$;

notify pgrst, 'reload schema';

select
  count(*) as total_map_rows,
  count(*) filter (where coalesce(active,true)=true) as active_map_rows,
  count(*) filter (where coalesce(active,true)=false) as inactive_map_rows
from public.company_techs;
