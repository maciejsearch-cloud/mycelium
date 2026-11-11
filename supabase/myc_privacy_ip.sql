-- Prywatność (01.11.2026, audyt anonimowości): skróty IP nie są publiczne.
-- myc_ip() = md5(stała sól z repozytorium || IP) – sól jest jawna, więc skrót z publicznej tabeli
-- dało się odwrócić przeglądem całej przestrzeni IPv4 (ok. 4,3 mld kandydatów, minuty na GPU).
-- Kolumny proposer_ip / ip_hash czytają dalej funkcje security definer (sprawdzanie niezależności
-- weryfikatorów), ale nie anon ani authenticated. Uwaga: prawa są teraz na poziomie kolumn – nowa
-- kolumna w tych tabelach wymaga własnego GRANT SELECT, a zapytania `select=*` z REST nie zadziałają.
revoke select on public.myc_candidates from anon, authenticated;
grant select (id, model, version, path, acc_claimed, val_acc, eval_n, eval_sha, meta, accepted, rejected,
  proposer, status, verified_acc, verifiers, reason, created_at, decided_at) on public.myc_candidates to anon, authenticated;
revoke select on public.myc_candidate_evals from anon, authenticated;
grant select (candidate_id, node, trusted, acc, sha, n, backend, created_at, ppl)
  on public.myc_candidate_evals to anon, authenticated;
