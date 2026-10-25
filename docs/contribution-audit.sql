-- Zapytania audytu wkładu węzłów (docs/contribution-audit.md); uruchamiane na bazie produkcyjnej tylko do odczytu.
-- 1. per węzeł / backend / model / rodzaj / status
select left(node_id::text, 8) node, model, kind, status, backend, count(*) n, sum(samples) samples,
       round((sum(flops) / 1e12)::numeric, 2) tflop, round((sum(ms) / 3.6e6)::numeric, 2) hours,
       min(created_at)::date first, max(created_at)::date last
  from myc_results group by 1, 2, 3, 4, 5 order by node, model, kind, status;
-- 2. sumy per węzeł (= widok myc_node_contrib)
select * from myc_node_contrib order by hours desc;
-- 3. backend (GPU = webgpu) i dzienny bilans
select * from myc_backend_contrib;
select * from myc_daily_contrib order by day;
-- 4. postęp modeli: wersje dziennie
select model, created_at::date d, count(*) versions, round(min(acc)::numeric, 4) lo, round(max(acc)::numeric, 4) hi
  from myc_models group by 1, 2 order by 1, 2;
-- 5. linia FedAvg: przyjęte aktualizacje per model i węzeł
select model, left(node_id::text, 8) node, count(*) from myc_results where status = 'accepted' group by 1, 2 order by 1, 3 desc;
-- 6. powody odrzuceń wersji
select model, regexp_replace(reason, '[0-9.]+', 'N', 'g') r, count(*), max(created_at)::date
  from myc_model_rejections group by 1, 2 order by 3 desc;
-- 7. kto w ogóle brał zadania (węzeł bez dzierżaw = nie pracował)
select left(lease_node::text, 8), count(*), max(lease_until) from myc_jobs where lease_node is not null group by 1 order by 3 desc;
-- 8. wielokrotne oceny tej samej wersji
select model, version, count(*) from myc_results where kind = 'eval' group by 1, 2 order by 3 desc limit 10;
