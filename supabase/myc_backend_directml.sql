-- Węzeł PC z GPU przez DirectML (wariant MyceliumNode-DirectML.exe, src/iot_mycelium/mesh/gpu.py): uczciwa etykieta
-- miejsca obliczeń w myc_results.backend zamiast 'cpu'. Bramka i weryfikator f32 bez zmian.
alter table public.myc_results drop constraint if exists myc_results_backend_check;
alter table public.myc_results add constraint myc_results_backend_check
  check (backend in ('webgpu', 'webgl', 'wasm', 'cpu', 'directml'));

-- Statystyki wkładu: DirectML liczy się jako GPU (definicja jak na produkcji, tylko rozszerzony filtr).
CREATE OR REPLACE FUNCTION public.myc_compute_stats()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'contributors', coalesce((select jsonb_agg(c order by c.flops desc) from (
      select contributor_id, count(*)::int jobs, sum(samples)::bigint samples, sum(flops) flops,
             sum(flops) filter (where backend in ('webgpu', 'webgl', 'directml')) gpu_flops,
             sum(flops) filter (where backend in ('wasm', 'cpu')) cpu_flops,
             count(*) filter (where status = 'accepted')::int accepted, count(*) filter (where status = 'rejected')::int rejected,
             max(created_at) last
      from myc_results group by contributor_id order by sum(flops) desc limit 100) c), '[]'),
    'hourly', coalesce((select jsonb_agg(h order by h.t) from (
      select date_trunc('hour', created_at) t, sum(samples)::bigint samples, sum(flops) flops,
             sum(flops) filter (where backend in ('webgpu', 'webgl', 'directml')) gpu_flops
      from myc_results where created_at > now() - interval '14 days' group by 1) h), '[]'),
    'backends', coalesce((select jsonb_object_agg(backend, jsonb_build_object('jobs', n, 'samples', s, 'ms', ms, 'flops', f)) from (
      select backend, count(*) n, sum(samples) s, sum(ms) ms, sum(flops) f from myc_results where kind in ('train', 'hparam') group by backend) b), '{}'),
    'queue', (select jsonb_build_object('open', count(*) filter (where status = 'open'), 'leased', count(*) filter (where status = 'leased' and lease_until > now()),
              'done', count(*) filter (where status = 'done')) from myc_jobs where created_at > now() - interval '2 days')
  )
$function$;
