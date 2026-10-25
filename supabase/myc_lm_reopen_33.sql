-- Jednorazowo (25.10.2026): kandydat 33 (lm v2) został odrzucony na ocenie węzła box1 w bf16 (706/2000) 7 s przed
-- wynikiem zaufanego weryfikatora f32 (713/2000, perpleksja 30,7467 przy v1: 712/2000, 32,8244; przebieg
-- https://github.com/maciejsearch-cloud/demo/actions/runs/40134890654 – wynik nie został zapisany, bo kandydat
-- był już „not pending”). Po zmianie bramki (rozstrzyga f32) kandydat wraca do oczekujących i weryfikator
-- liczy go od nowa; o publikacji decyduje wyłącznie nowy przebieg. Wpis odrzucenia zostaje w myc_model_rejections.
update public.myc_candidates
   set status = 'pending', reason = null, decided_at = null, verified_acc = null,
       meta = meta || jsonb_build_object('reopened', jsonb_build_object(
         'at', now(), 'prev_status', status, 'prev_reason', reason, 'prev_verifiers', verifiers,
         'why', 'gate now decided by f32 verifier; earlier rejection came from a node bf16 re-eval'))
 where id = 33 and model = 'lm' and status = 'rejected'
   and not exists (select 1 from public.myc_candidates where model = 'lm' and status = 'pending')
   and (select max(version) from public.myc_models where model = 'lm') = 1;
