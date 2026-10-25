-- Pytania logiczne grzybni w Ucz AI („Oczekujące pytania od grzybni”), 25.10.2026.
-- Identyfikatory l + 8 znaków hex (sha256 pytania); odpowiedzi to kody tak/nie/nw/zle albo litery a–h.
-- Odpowiedzi kontrolne (sprawdzalne programem) ładuje scripts/gold_rotate.py (z tajnego MYC_GOLD_SEED, poza repo) → myc_gold (niewidoczne dla przeglądarki).
alter table public.myc_answers drop constraint if exists myc_answers_question_id_check;
alter table public.myc_answers add constraint myc_answers_question_id_check
  check (question_id ~ '^([iks][0-9]{2,3}|u[0-9a-f]{8}|w[0-9]{5}c[0-9]{3}|cg[0-9]{5}k[0-9]|c[tromn][0-9]{5}|l[0-9a-f]{8})$');
