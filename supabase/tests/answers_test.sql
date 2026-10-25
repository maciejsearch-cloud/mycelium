-- Test odpowiedzi czatu w Weryfikuj (transakcja wycofywana wyjątkiem). Oczekiwane: scrub bez e-maila/linku/telefonu/imienia,
-- own=odrzucony, po 3 poprawkach status=corrected, strzępek 'odpowiedz' verified, wpis w myc_error_set, anon nie zapisze stanu.
do $$
declare r jsonb; id_ bigint; o text := ''; n0 uuid := '00000000-0000-4000-8000-00000000a000';
begin
  o := o || ' scrub=' || myc_scrub('mam na imię Kasia, pisz: kasia@x.pl https://x.pl/a +48 600 100 200 @kasia_k');
  r := myc_answer_log(n0, null, 'Kto napisał Lalkę? mój mail a@b.com', 'Bolesław Prus', '[{"kind":"wikipedia","title":"Lalka","url":"https://pl.wikipedia.org/wiki/Lalka_(powie%C5%9B%C4%87)"},{"kind":"x","url":"https://evil.example/"}]'::jsonb,
    0.8, 'literatura', 'kultura', 'pytanie', 'neutralne', 'wiki', 'lite', 'e2e');
  id_ := (r ->> 'id')::bigint; o := o || ' log=' || r::text;
  o := o || ' row=' || (select jsonb_build_object('q', question, 'has_source', has_source, 'src', sources) from myc_chat_answers where id = id_)::text;
  o := o || ' own=' || myc_answer_vote(null, n0, null, id_, 'confirm')::text;
  r := myc_answer_vote(null, '00000000-0000-4000-8000-00000000a001', null, id_, 'correct', 'Bolesław Prus (Aleksander Głowacki)', 'https://pl.wikipedia.org/wiki/Boles%C5%82aw_Prus');
  r := myc_answer_vote(null, '00000000-0000-4000-8000-00000000a002', null, id_, 'correct', 'Bolesław Prus (Aleksander Głowacki)', null);
  r := myc_answer_vote(null, '00000000-0000-4000-8000-00000000a003', null, id_, 'correct', 'bolesław prus (aleksander głowacki)', null);
  o := o || ' final=' || r::text;
  o := o || ' frag=' || coalesce((select jsonb_build_object('rel', rel, 'status', status, 'ref', source_ref) from myc_frags where id = (r ->> 'frag')::bigint)::text, 'null');
  o := o || ' errset=' || coalesce((select jsonb_build_object('correct', correct_answer, 'by', decided_by) from myc_error_set where answer_id = id_)::text, 'null');
  begin
    set local role anon;
    update myc_chat_answers set status = 'confirmed' where id = id_;
    o := o || ' anon_update=ALLOWED(BAD)';
  exception when others then o := o || ' anon_update=denied';
  end;
  reset role;
  raise exception 'ROLLBACK %', o;
end $$;
