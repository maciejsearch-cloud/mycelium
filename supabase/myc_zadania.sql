-- Zadania wielokierunkowe w Ucz AI (podział na typy), 25.10.2026.
-- Nowe identyfikatory pytań: m + 8 hex (matematyczne), a + 8 hex (analityczne), v + 8 hex (wzrokowe, obraz Fashion-MNIST).
-- Odpowiedzi: litery a–j albo „zle”. Poprawne odpowiedzi (wszystkie zadania są sprawdzane programem) są w
-- scripts/gold_rotate.py (tajne MYC_GOLD_SEED, poza repo) → myc_gold (niewidoczne dla przeglądarki). myc_gold_by_type grupuje po pierwszej literze (m, a, v).
alter table public.myc_answers drop constraint if exists myc_answers_question_id_check;
alter table public.myc_answers add constraint myc_answers_question_id_check
  check (question_id ~ '^([iks][0-9]{2,3}|u[0-9a-f]{8}|w[0-9]{5}c[0-9]{3}|cg[0-9]{5}k[0-9]|c[tromn][0-9]{5}|[lmav][0-9a-f]{8})$');
