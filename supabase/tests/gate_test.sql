-- Test bramki (w transakcji wycofywanej wyjątkiem). Oczekiwane: reserve ok, reserve2 busy, regress odrzucone, badset odrzucone, equal ok.
do $$
declare r jsonb; v int; a real; n uuid := '00000000-0000-4000-8000-0000000000aa'; ids bigint[]; s text; o text := '';
begin
  select max(version) into v from myc_models where model = 'words';
  select acc into a from myc_models where model = 'words' and version = v;
  select sha into s from myc_eval_sets where model = 'words';
  r := myc_reserve(n, 'words', v); o := o || ' reserve=' || r::text;
  r := myc_reserve('00000000-0000-4000-8000-0000000000bb', 'words', v); o := o || ' reserve2=' || r::text;
  insert into storage.objects (bucket_id, name) values ('myc-models', 'words/v' || (v+1) || '-deadbeef.bin');
  insert into myc_jobs (model, version, kind) values ('words', v, 'train');
  insert into myc_results (job_id, model, version, kind, node_id, samples, flops, ms, backend, status)
    select currval(pg_get_serial_sequence('myc_jobs','id')), 'words', v, 'train', n, 1, 1, 1, 'cpu', 'pending' from generate_series(1,3);
  select array_agg(id) into ids from myc_results where node_id = n;
  r := myc_publish_v2(n, 'words', v+1, 'words/v' || (v+1) || '-deadbeef.bin', (a - 0.001)::real, 0.4::real, 1086, s, '{}'::jsonb, ids, '{}'::bigint[]); o := o || ' regress=' || r::text;
  r := myc_reserve(n, 'words', v);
  update myc_results set status = 'pending' where node_id = n;
  r := myc_publish_v2(n, 'words', v+1, 'words/v' || (v+1) || '-deadbeef.bin', a, 0.4::real, 1086, repeat('0',64), '{}'::jsonb, ids, '{}'::bigint[]); o := o || ' badset=' || r::text;
  r := myc_reserve(n, 'words', v);
  update myc_results set status = 'pending' where node_id = n;
  r := myc_publish_v2(n, 'words', v+1, 'words/v' || (v+1) || '-deadbeef.bin', a, 0.4::real, 1086, s, '{}'::jsonb, ids, '{}'::bigint[]); o := o || ' equal=' || r::text;
  raise exception 'ROLLBACK %', o;
end $$;
