-- Test bramki modelu językowego (w transakcji wycofywanej wyjątkiem): ocena węzła (bf16) nie rozstrzyga,
-- rozstrzyga zaufany weryfikator f32. Oczekiwane: node=waiting for f32 verifier, trusted=ok (publikacja).
do $$
declare r jsonb; v int; cur myc_models; es myc_eval_sets; n uuid := '00000000-0000-4000-8000-0000000000aa';
  nb uuid := '00000000-0000-4000-8000-0000000000bb'; t myc_trusted_nodes; cid bigint; ids bigint[]; o text := '';
begin
  select * into cur from myc_models where model = 'lm' order by version desc limit 1;
  select * into es from myc_eval_sets where model = 'lm';
  select * into t from myc_trusted_nodes limit 1;
  update myc_candidates set status = 'rejected' where model = 'lm' and status = 'pending';
  insert into myc_jobs (model, version, kind) values ('lm', cur.version, 'train');
  insert into myc_results (job_id, model, version, kind, node_id, samples, flops, ms, backend, status)
    select currval(pg_get_serial_sequence('myc_jobs','id')), 'lm', cur.version, 'train', n, 1, 1, 1, 'cpu', 'pending' from generate_series(1,3);
  select array_agg(id) into ids from myc_results where node_id = n and model = 'lm' and status = 'pending';
  insert into myc_candidates (model, version, path, acc_claimed, eval_n, eval_sha, meta, accepted, rejected, proposer, proposer_ip)
    values ('lm', cur.version + 1, 'lm/v' || (cur.version + 1) || '-deadbeef.bin', (cur.acc + 0.004)::real, es.n, es.sha,
            jsonb_build_object('ppl', (cur.meta ->> 'ppl')::real - 2), ids, '{}', n, 'ip-a') returning id into cid;
  -- węzeł bf16: gorzej o 6 pytań – dawniej odrzucenie, teraz czekanie
  insert into myc_candidate_evals (candidate_id, node, ip_hash, acc, sha, n, backend, ppl)
    values (cid, nb, 'ip-b', (cur.acc - 0.003)::real, es.sha, es.n, 'cpu', (cur.meta ->> 'ppl')::real - 2);
  r := myc_finalize(cid); o := o || ' node=' || (r ->> 'reason');
  -- weryfikator f32: +1 pytanie, perpleksja niższa → publikacja
  insert into myc_candidate_evals (candidate_id, node, ip_hash, trusted, acc, sha, n, backend, ppl)
    values (cid, t.node, 'trusted:' || t.label, true, (cur.acc + 0.0005)::real, es.sha, es.n, 'torch-f32', (cur.meta ->> 'ppl')::real - 2.05);
  r := myc_finalize(cid); o := o || ' trusted=' || r::text;
  o := o || ' decided_by=' || coalesce((select meta ->> 'decided_by' from myc_models where model = 'lm' and version = cur.version + 1), '-');
  raise exception 'ROLLBACK %', o;
end $$;
