-- Węzły w czasie (prawdziwe zdarzenia: odpowiedzi, wzrost, trening federacyjny, wyniki obliczeń)
-- oraz polecenia (zaproszenia z ?ref=). Tylko odczyt agregatów, bez danych osobowych.
create or replace function public.myc_node_daily()
returns table (day date, active int, new_nodes int, total int)
language sql stable security definer set search_path = public, pg_temp as $$
  with ev as (
    select node_id, created_at from myc_answers
    union all select node_id, created_at from myc_growth
    union all select node_id, created_at from myc_fed
    union all select node_id, created_at from myc_results
  ), d as (
    select distinct node_id, (created_at at time zone 'Europe/Amsterdam')::date as day from ev where node_id is not null
  ), f as (select node_id, min(day) as day from d group by node_id),
  days as (select day, count(*)::int as active from d group by day)
  select days.day, days.active,
    (select count(*) from f where f.day = days.day)::int,
    (select count(*) from f where f.day <= days.day)::int
  from days order by days.day desc limit 365
$$;
revoke all on function public.myc_node_daily() from public;
grant execute on function public.myc_node_daily() to anon, authenticated;

create or replace function public.myc_referrals()
returns table (ref text, joins int, last timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select detail ->> 'ref', count(distinct node_id)::int, max(created_at)
  from myc_growth
  where event = 'join' and detail ->> 'ref' ~ '^[0-9a-f]{8}$'
  group by 1 order by 2 desc limit 200
$$;
revoke all on function public.myc_referrals() from public;
grant execute on function public.myc_referrals() to anon, authenticated;
