-- Zdrowie bazy (25.10.2026, po awarii UNHEALTHY; restart 02:10 CET). Opis i niepotwierdzone hipotezy: docs/incident-2026-10-25.md.
-- Co naprawia (pewne z liczności przez REST): ładunki rozstrzygniętych wyników nigdy nie były czyszczone przy odrzuceniu –
-- ok. 5 900 wierszy, ~580 MB base64 w myc_results.payload (LM v1: 116 × ~1 MB). Czyszczenie partiami (pg_cron) + indeksy.
-- Sprawdzone lokalnie (PostgreSQL 16, 100 × 1 MB): CHECK z regex na payload NIE spowalnia `update ... set status`
-- (482 ms vs 505 ms bez niego) – więc CHECK zostaje bez zmian.

-- 1. Czyszczenie ładunków rozstrzygniętych wyników (aktualizacje odrzucone / już zagregowane / oceny) – partiami,
--    żeby żadna instrukcja nie trzymała blokad długo. Wyniki 'pending' (runda w toku, weryfikacje) zostają.
create or replace function public.myc_payload_gc(p_limit int default 300) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update myc_results set payload = null
   where id in (select id from myc_results where payload is not null and status <> 'pending'
                  and created_at < now() - interval '30 minutes' order by id limit p_limit for update skip locked);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.myc_payload_gc(int) from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'myc_payload_gc';
select cron.schedule('myc_payload_gc', '*/5 * * * *', $$select public.myc_payload_gc(300)$$);

-- 2. Indeksy pod zapytania rund i zadań
create index if not exists myc_results_payload_live on public.myc_results (model, version) where payload is not null;
create index if not exists myc_jobs_reeval_cand on public.myc_jobs (((params ->> 'candidate'))) where kind = 'reeval';
create index if not exists myc_jobs_open on public.myc_jobs (model, kind, id) where status in ('open', 'leased');

-- 3. Jednorazowo po wdrożeniu (poza transakcją migracji, kilka razy aż zwróci 0):
--      select public.myc_payload_gc(2000);
--    potem: vacuum (analyze) public.myc_results;   (zwykły VACUUM – bez blokady tabeli; FULL tylko w oknie serwisowym)
