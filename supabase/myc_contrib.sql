-- Wkład węzłów (zakładka Weryfikacja → „Wkład węzłów”, docs/contribution-audit.md): agregaty z prawdziwych wierszy
-- myc_results. Aktualizacja „przyjęta” = weszła do opublikowanej wersji (myc_finalize), „odrzucona” = bramka/regresja.
-- Widoki pokazują tylko sumy (bez ładunków i adresów), do odczytu publicznie.
create or replace view public.myc_node_contrib as
select node_id,
       string_agg(distinct backend, ',' order by backend) as backends,
       count(*) as results,
       count(*) filter (where kind in ('train', 'hparam')) as updates,
       count(*) filter (where status = 'accepted') as accepted,
       count(*) filter (where status = 'rejected') as rejected,
       count(*) filter (where status = 'pending') as pending,
       count(*) filter (where kind in ('eval', 'verify', 'reeval')) as evals,
       round((coalesce(sum(ms), 0) / 3.6e6)::numeric, 2) as hours,
       round((coalesce(sum(ms) filter (where status = 'rejected'), 0) / 3.6e6)::numeric, 2) as hours_rejected,
       coalesce(sum(flops), 0)::double precision as flops,
       coalesce(sum(flops) filter (where status = 'accepted'), 0)::double precision as flops_used,
       array_remove(array_agg(distinct model) filter (where status = 'accepted'), null) as models_used,
       min(created_at) as first_at,
       max(created_at) as last_at
  from public.myc_results
 group by node_id;

create or replace view public.myc_backend_contrib as
select backend, count(*) as results,
       count(*) filter (where status = 'accepted') as accepted,
       count(*) filter (where status = 'rejected') as rejected,
       round((coalesce(sum(ms), 0) / 3.6e6)::numeric, 2) as hours,
       coalesce(sum(flops), 0)::double precision as flops
  from public.myc_results group by backend;

-- dzienny bilans: ile pracy weszło do modeli, a ile odrzuciła bramka
create or replace view public.myc_daily_contrib as
select (created_at at time zone 'Europe/Amsterdam')::date as day,
       count(*) filter (where kind in ('train', 'hparam') and status = 'accepted') as accepted,
       count(*) filter (where kind in ('train', 'hparam') and status = 'rejected') as rejected,
       round((coalesce(sum(ms), 0) / 3.6e6)::numeric, 2) as hours,
       round((coalesce(sum(ms) filter (where status = 'rejected'), 0) / 3.6e6)::numeric, 2) as hours_rejected
  from public.myc_results group by 1;

grant select on public.myc_node_contrib, public.myc_backend_contrib, public.myc_daily_contrib to anon, authenticated;
