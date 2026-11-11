-- Model językowy grzybni (model = 'lm'): adapter LoRA Qwen2.5-0.5B trenowany federacyjnie na węzłach (src/iot_mycelium/mesh/lm.py).
-- Te same mechanizmy co pozostałe modele (dzierżawy zadań, rundy, kandydat → niezależna ocena → bramka bez regresji), plus:
--   * acc = trafność wyboru definicji (1 z 4) na stałym teście; bramka liczy trafienia (tolerancja 0),
--   * meta.ppl = perpleksja na odłożonych akapitach polskiej Wikipedii; nie może wzrosnąć (najgorsza z niezależnych ocen),
--   * decyduje zaufany weryfikator f32 (CI, myc_reeval_trusted_lm): oceny węzłów (bf16) są zapisywane jako
--     dodatkowy dowód, ale nie rozstrzygają (25.10.2026: kandydat 33 odrzucony na bf16 706/2000 węzła box1,
--     f32 dało 713/2000 7 s później); gdy weryfikatora brak 6 h, wystarcza 1 niezależny węzeł z innego IP,
--   * dzierżawa 45 min (CPU, 2000 pytań), aktualizacja (adapter fp16, ok. 1 MB w base64) w myc_results.payload.

alter table public.myc_models drop constraint if exists myc_models_model_check;
alter table public.myc_models add constraint myc_models_model_check check (model in ('fashion', 'har', 'intent', 'words', 'lm'));
alter table public.myc_eval_sets drop constraint if exists myc_eval_sets_model_check;
alter table public.myc_eval_sets add constraint myc_eval_sets_model_check check (model in ('fashion', 'har', 'intent', 'words', 'lm', 'taxo', 'rotate', 'objects', 'ocr'));
alter table public.myc_results drop constraint if exists myc_results_payload_check;
alter table public.myc_results add constraint myc_results_payload_check check (payload is null or (
  char_length(payload) <= case when model = 'lm' then 1200000 else 400000 end and payload ~ '^[A-Za-z0-9+/=]*$'));
alter table public.myc_candidate_evals add column if not exists ppl real check (ppl is null or ppl > 0);

-- stały zbiór testowy modelu językowego (web/public/data/lm/eval.bin): n = liczba pytań wyboru, sha = SHA-256 pliku
--   wersja 1 (19.10.2026): 250 pytań, sha 4e7b2048…; wersja 2 (24.10.2026, decyzja właściciela): 2000 pytań.
-- Zmiana zbioru: bieżąca wersja modelu dostaje nowy punkt odniesienia dopiero po przeliczeniu przez zaufanego
-- weryfikatora (myc_rebase_lm); do tego czasu nowi kandydaci nie są przyjmowani ani publikowani.
alter table public.myc_eval_sets add column if not exists version int not null default 1;
create table if not exists public.myc_eval_set_history (
  model text not null, version int not null, n int not null, sha text not null, created_at timestamptz not null default now(),
  primary key (model, version));
alter table public.myc_eval_set_history enable row level security;
drop policy if exists myc_eval_set_history_read on public.myc_eval_set_history;
create policy myc_eval_set_history_read on public.myc_eval_set_history for select to anon, authenticated using (true);
grant select on public.myc_eval_set_history to anon, authenticated;
insert into public.myc_eval_set_history (model, version, n, sha, created_at) values
  ('lm', 1, 250, '4e7b2048dff5207939345f2f32c82b0a48f664cac0d30680e91ecd0100aae79c', '2026-10-19 07:00+00'),
  ('lm', 2, 2000, '9bebb6f48df885029b02a0e97df6a1371458877b8608d9a4c1e1311f4bc66a0a', now())
  on conflict do nothing;
insert into public.myc_eval_sets (model, n, sha, version) values ('lm', 2000, '9bebb6f48df885029b02a0e97df6a1371458877b8608d9a4c1e1311f4bc66a0a', 2)
  on conflict (model) do update set n = excluded.n, sha = excluded.sha, version = excluded.version;
-- kandydaci ocenieni na starym zbiorze nie mogą już przejść bramki
update public.myc_candidates set status = 'rejected', reason = 'eval set changed', decided_at = now()
  where model = 'lm' and status = 'pending' and eval_sha <> '9bebb6f48df885029b02a0e97df6a1371458877b8608d9a4c1e1311f4bc66a0a';

drop policy if exists myc_models_upload on storage.objects;
create policy myc_models_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'myc-models' and name ~ '^(fashion|har|intent|words|lm)/v[0-9]{1,6}-[0-9a-f]{8}\.bin$');

create or replace function public.myc_finalize(p_cand bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c myc_candidates; cur myc_models; latest int; n_tr int; n_ip int; vmin real; vmax_dev real; ver jsonb; why text;
  pmax real; pdev real; n_ppl int; cur_ppl real; claimed_ppl real; only_tr boolean;
begin
  perform pg_advisory_xact_lock(hashtext('myc_round:' || (select model from myc_candidates where id = p_cand)));
  select * into c from myc_candidates where id = p_cand for update;
  if c.id is null or c.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'not pending'); end if;
  -- kwalifikują się: inny węzeł, inne IP niż zgłaszający, ten sam zbiór testowy
  select count(*) filter (where trusted), count(distinct ip_hash) filter (where not trusted),
         min(acc), max(abs(acc - c.acc_claimed)),
         jsonb_agg(jsonb_build_object('node', node, 'acc', acc, 'ppl', ppl, 'trusted', trusted, 'backend', backend) order by created_at),
         max(ppl), count(ppl)
    into n_tr, n_ip, vmin, vmax_dev, ver, pmax, n_ppl
    from myc_candidate_evals e
   where e.candidate_id = c.id and e.node <> c.proposer and (e.trusted or e.ip_hash <> c.proposer_ip)
     and e.sha = c.eval_sha and e.n = c.eval_n;
  if n_tr < 1 and n_ip < (case when c.model = 'lm' then 1 else 2 end) then return jsonb_build_object('ok', false, 'reason', 'waiting', 'trusted', n_tr, 'ips', n_ip); end if;
  -- model językowy: rozstrzyga niezależny weryfikator f32 (zaufany); oceny węzłów (zwykle bf16, rozrzut ±7 pytań
  -- na 2000) tylko gdy weryfikatora nie ma od 6 godzin. Węzły nadal liczą – ich wyniki zostają w verifiers.
  if c.model = 'lm' then
    if n_tr < 1 and c.created_at > now() - interval '6 hours' then
      return jsonb_build_object('ok', false, 'reason', 'waiting for f32 verifier', 'trusted', n_tr, 'ips', n_ip);
    end if;
    only_tr := n_tr >= 1;
    select min(acc), max(abs(acc - c.acc_claimed)), max(ppl), count(ppl), count(*)
      into vmin, vmax_dev, pmax, n_ppl, n_tr
      from myc_candidate_evals e
     where e.candidate_id = c.id and e.node <> c.proposer and (e.trusted or e.ip_hash <> c.proposer_ip)
       and e.sha = c.eval_sha and e.n = c.eval_n and (e.trusted or not only_tr);
    n_ip := 0;  -- liczba ocen rozstrzygających jest już w n_tr (dla kontroli kompletności perpleksji)
  end if;
  select max(version) into latest from myc_models where model = c.model;
  select * into cur from myc_models where model = c.model and version = latest;
  -- model językowy: punkt odniesienia bramki musi być policzony na tym samym zbiorze testowym (myc_rebase_lm)
  if c.model = 'lm' and cur.version is not null and (cur.meta ->> 'eval_sha') is distinct from c.eval_sha then
    return jsonb_build_object('ok', false, 'reason', 'baseline pending');
  end if;
  if coalesce(latest, -1) + 1 <> c.version then why := 'stale';
  elsif vmax_dev > 0.01 then why := format('claim mismatch: declared %s, verified min %s', round(c.acc_claimed::numeric, 4), round(vmin::numeric, 4));
  -- porównanie w liczbie trafień na stałym zbiorze (odporne na zaokrąglenia klienta)
  elsif cur.acc is not null and round(vmin::numeric * c.eval_n) < round(cur.acc::numeric * c.eval_n) then why := format('regression %s < %s', round(vmin::numeric, 4), round(cur.acc::numeric, 4));
  end if;
  -- model językowy: perpleksja na stałym teście (najgorsza z niezależnych ocen) nie może wzrosnąć, deklaracja zgodna do 1%
  if why is null and c.model = 'lm' then
    claimed_ppl := (c.meta ->> 'ppl')::real;
    cur_ppl := (cur.meta ->> 'ppl')::real;
    if n_ppl < (n_tr + n_ip) or pmax is null or claimed_ppl is null then why := 'missing perplexity';
    elsif abs(pmax - claimed_ppl) / claimed_ppl > 0.01 then why := format('ppl claim mismatch: declared %s, verified max %s', round(claimed_ppl::numeric, 3), round(pmax::numeric, 3));
    elsif cur_ppl is not null and pmax > cur_ppl then why := format('ppl regression %s > %s', round(pmax::numeric, 3), round(cur_ppl::numeric, 3));
    end if;
  end if;
  if why is not null then
    update myc_candidates set status = 'rejected', reason = why, verified_acc = vmin, verifiers = ver, decided_at = now() where id = c.id;
    insert into myc_model_rejections (model, version, node, acc, cur_acc, val_acc, eval_n, reason, meta)
      values (c.model, c.version, c.proposer, vmin, cur.acc, c.val_acc, c.eval_n, why, c.meta || jsonb_build_object('claimed', c.acc_claimed, 'verifiers', ver));
    update myc_results set status = 'rejected'
      where model = c.model and version = c.version - 1 and kind in ('train', 'hparam') and status = 'pending';
    update myc_jobs set status = 'expired' where model = c.model and version = c.version - 1 and status in ('open', 'leased');
    update myc_jobs set status = 'expired' where kind = 'reeval' and (params ->> 'candidate')::bigint = c.id and status in ('open', 'leased');
    return jsonb_build_object('ok', false, 'reason', why);
  end if;
  insert into myc_models (model, version, path, acc, val_acc, n_updates, n_rejected, samples, flops, meta, created_by, verifiers)
    select c.model, c.version, c.path, vmin, c.val_acc, cardinality(c.accepted), cardinality(c.rejected),
           coalesce(sum(samples), 0), coalesce(sum(flops), 0),
           c.meta || jsonb_build_object('eval_n', c.eval_n, 'gate_prev', cur.acc, 'claimed', c.acc_claimed, 'candidate', c.id)
             || case when c.model = 'lm' then jsonb_build_object('ppl', pmax, 'ppl_claimed', c.meta -> 'ppl', 'ppl_prev', cur.meta -> 'ppl',
                  'eval_sha', c.eval_sha, 'eval_version', (select version from myc_eval_sets where model = 'lm'),
                  'correct', round(vmin::numeric * c.eval_n)::int, 'decided_by', case when only_tr then 'f32 verifier' else 'node re-eval (no verifier 6 h)' end) else '{}'::jsonb end,
           c.proposer, ver
    from myc_results where id = any (c.accepted);
  update myc_candidates set status = 'published', verified_acc = vmin, verifiers = ver, decided_at = now() where id = c.id;
  update myc_results set status = 'accepted' where id = any (c.accepted);
  update myc_results set status = 'rejected' where id = any (c.rejected) and status = 'pending';
  update myc_results set status = 'rejected' where model = c.model and version = c.version - 1 and kind in ('train', 'hparam') and status = 'pending';
  update myc_jobs set status = 'expired' where model = c.model and version < c.version and status in ('open', 'leased');
  update myc_jobs set status = 'expired' where kind = 'reeval' and (params ->> 'candidate')::bigint = c.id and status in ('open', 'leased');
  update myc_results set payload = null where model = c.model and version < c.version - 1 and payload is not null;
  return jsonb_build_object('ok', true, 'version', c.version, 'acc', vmin);
end $$;

create or replace function public.myc_propose(p_node uuid, p_model text, p_version int, p_path text, p_acc real, p_val real,
  p_eval_n int, p_eval_sha text, p_meta jsonb, p_accepted bigint[], p_rejected bigint[])
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare latest int; cur myc_models; l myc_publish_lease; es myc_eval_sets; ok int; cid bigint; F double precision;
begin
  perform myc_rl('publish:' || p_node, 12);
  perform pg_advisory_xact_lock(hashtext('myc_round:' || p_model));
  select max(version) into latest from myc_models where model = p_model;
  if coalesce(latest, -1) + 1 <> p_version then return jsonb_build_object('ok', false, 'reason', 'stale', 'latest', latest); end if;
  if exists (select 1 from myc_candidates where model = p_model and status = 'pending') then return jsonb_build_object('ok', false, 'reason', 'candidate pending'); end if;
  select * into l from myc_publish_lease where model = p_model;
  if l.model is null or l.node <> p_node or l.version <> p_version or l.until < now() - interval '30 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'no reservation');
  end if;
  if p_path !~ ('^' || p_model || '/v' || p_version || '-[0-9a-f]{8}\.bin$') then return jsonb_build_object('ok', false, 'reason', 'bad path'); end if;
  if not exists (select 1 from storage.objects where bucket_id = 'myc-models' and name = p_path) then
    return jsonb_build_object('ok', false, 'reason', 'weights not uploaded');
  end if;
  if p_acc is null or p_acc < 0 or p_acc > 1 then return jsonb_build_object('ok', false, 'reason', 'bad acc'); end if;
  if p_model = 'lm' and jsonb_typeof(p_meta -> 'ppl') is distinct from 'number' then return jsonb_build_object('ok', false, 'reason', 'missing ppl'); end if;
  select * into es from myc_eval_sets where model = p_model;
  if es.model is null or p_eval_n is distinct from es.n or p_eval_sha is distinct from es.sha then
    return jsonb_build_object('ok', false, 'reason', 'eval set mismatch');
  end if;
  if p_model = 'lm' and p_version > 0 and not exists (select 1 from myc_models where model = 'lm' and version = latest and meta ->> 'eval_sha' = es.sha) then
    delete from myc_publish_lease where model = p_model;
    return jsonb_build_object('ok', false, 'reason', 'baseline pending');
  end if;
  if p_version > 0 then
    select count(*) into ok from myc_results
      where id = any (p_accepted) and model = p_model and version = latest and kind in ('train', 'hparam') and status = 'pending';
    if ok < 3 or ok <> cardinality(p_accepted) then
      delete from myc_publish_lease where model = p_model;
      return jsonb_build_object('ok', false, 'reason', 'need >= 3 valid pending updates');
    end if;
    select * into cur from myc_models where model = p_model and version = latest;
    -- deklaracja gorsza od bieżącej: od razu odrzucamy (nie ma czego weryfikować)
    -- model językowy: deklaracja węzła (bf16) różni się od f32 o kilka pytań – odrzucamy od razu tylko wyraźną
    -- regresję (> 10 pytań albo perpleksja > +1%), resztę rozstrzyga weryfikator f32
    if (p_model <> 'lm' and cur.acc is not null and round(p_acc::numeric * p_eval_n) < round(cur.acc::numeric * p_eval_n))
       or (p_model = 'lm' and cur.acc is not null and round(p_acc::numeric * p_eval_n) < round(cur.acc::numeric * p_eval_n) - 10)
       or (p_model = 'lm' and (p_meta ->> 'ppl')::real > (cur.meta ->> 'ppl')::real * 1.01) then
      insert into myc_model_rejections (model, version, node, acc, cur_acc, val_acc, eval_n, reason, meta)
        values (p_model, p_version, p_node, p_acc, cur.acc, p_val, p_eval_n, case when p_model = 'lm' then format('regression: acc %s (cur %s), ppl %s (cur %s)', round(p_acc::numeric, 4), round(cur.acc::numeric, 4), p_meta ->> 'ppl', cur.meta ->> 'ppl') else format('regression %s < %s', round(p_acc::numeric, 4), round(cur.acc::numeric, 4)) end, coalesce(p_meta, '{}'));
      update myc_results set status = 'rejected' where model = p_model and version = latest and kind in ('train', 'hparam') and status = 'pending';
      update myc_jobs set status = 'expired' where model = p_model and version = latest and kind in ('train', 'hparam', 'verify') and status in ('open', 'leased');
      delete from myc_publish_lease where model = p_model;
      return jsonb_build_object('ok', false, 'reason', 'regression', 'cur_acc', cur.acc);
    end if;
  end if;
  insert into myc_candidates (model, version, path, acc_claimed, val_acc, eval_n, eval_sha, meta, accepted, rejected, proposer, proposer_ip)
    values (p_model, p_version, p_path, p_acc, p_val, p_eval_n, p_eval_sha, coalesce(p_meta, '{}'), coalesce(p_accepted, '{}'), coalesce(p_rejected, '{}'), p_node, myc_ip())
    returning id into cid;
  -- zadania ponownej oceny (więcej niż 2, bo część węzłów może mieć to samo IP)
  F := coalesce((p_meta ->> 'flops')::double precision, 2e6);
  insert into myc_jobs (model, version, kind, params)
    select p_model, p_version, 'reeval', jsonb_build_object('candidate', cid, 'path', p_path, 'exclude', p_node::text, 'flops_per_sample', F)
    from generate_series(1, 4);
  -- otwarte zadania rundy nie są już potrzebne
  update myc_jobs set status = 'expired' where model = p_model and version = coalesce(latest, -1) and kind in ('train', 'hparam', 'verify') and status in ('open', 'leased');
  delete from myc_publish_lease where model = p_model;
  return jsonb_build_object('ok', true, 'candidate', cid, 'status', 'pending');
end $$;

create or replace function public.myc_claim(p_node uuid, p_models text[], p_kinds text[])
returns setof public.myc_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare j bigint; ip text := myc_ip();
begin
  perform myc_rl('claim:' || p_node, 150);
  update myc_jobs set status = 'expired' where status in ('open', 'leased') and attempts >= 5 and (lease_until is null or lease_until < now());
  select id into j from myc_jobs
   where (status = 'open' or (status = 'leased' and lease_until < now()))
     and model = any (p_models) and kind = any (p_kinds)
     and coalesce(params ->> 'exclude', '') <> p_node::text
     and (case when kind = 'reeval' then
            exists (select 1 from myc_candidates c where c.id = (myc_jobs.params ->> 'candidate')::bigint and c.status = 'pending' and c.proposer_ip <> ip)
            and not exists (select 1 from myc_candidate_evals e where e.candidate_id = (myc_jobs.params ->> 'candidate')::bigint and (e.node = p_node or e.ip_hash = ip))
            and not exists (select 1 from myc_jobs o where o.kind = 'reeval' and o.params ->> 'candidate' = myc_jobs.params ->> 'candidate' and o.status = 'leased' and o.lease_until > now() and o.lease_node = p_node)
          else version = (select max(version) from myc_models m where m.model = myc_jobs.model) end)
   order by (kind in ('verify', 'reeval')) desc, id
   limit 1 for update skip locked;
  if j is null then return; end if;
  return query update myc_jobs set status = 'leased', lease_node = p_node, lease_until = now() + case when model = 'lm' then interval '45 minutes' else interval '3 minutes' end, attempts = attempts + 1
    where id = j returning *;
end $$;

create or replace function public.myc_submit(p_job bigint, p_node uuid, p_contrib uuid, p_payload text, p_metrics jsonb,
  p_samples int, p_flops double precision, p_ms int, p_backend text)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare jb myc_jobs; rid bigint; cid bigint;
begin
  perform myc_rl('submit:' || p_node, 120);
  select * into jb from myc_jobs where id = p_job for update;
  if jb.id is null or jb.status <> 'leased' or jb.lease_node <> p_node or jb.lease_until < now() - interval '30 seconds' then
    return -1;
  end if;
  if p_flops > 2 * coalesce((jb.params ->> 'flops_per_sample')::double precision, 1e7) * greatest(p_samples, 1) then
    raise exception 'myc: flops out of range' using errcode = 'PT422';
  end if;
  insert into myc_results (job_id, model, version, kind, node_id, contributor_id, payload, metrics, samples, flops, ms, backend, status)
    values (jb.id, jb.model, jb.version, jb.kind, p_node, coalesce(p_contrib, p_node), p_payload, coalesce(p_metrics, '{}'),
            p_samples, p_flops, p_ms, p_backend, case when jb.kind in ('train', 'hparam') then 'pending' else 'info' end)
    returning id into rid;
  update myc_jobs set status = 'done', lease_until = now() where id = jb.id;
  if jb.kind = 'reeval' and jsonb_typeof(p_metrics -> 'acc') = 'number' then
    cid := (jb.params ->> 'candidate')::bigint;
    insert into myc_candidate_evals (candidate_id, node, ip_hash, acc, sha, n, backend, ppl)
      values (cid, p_node, myc_ip(), least(greatest((p_metrics ->> 'acc')::real, 0), 1), coalesce(p_metrics ->> 'eval_sha', ''), coalesce((p_metrics ->> 'n')::int, 0), p_backend,
              case when jsonb_typeof(p_metrics -> 'ppl') = 'number' then (p_metrics ->> 'ppl')::real end)
      on conflict (candidate_id, node) do nothing;
    perform myc_finalize(cid);
  end if;
  if jb.kind = 'train' and jb.model <> 'lm' and rid % 4 = 0 then
    insert into myc_jobs (model, version, kind, params)
      values (jb.model, jb.version, 'verify', jsonb_build_object('result', rid, 'exclude', p_node::text,
              'flops_per_sample', (jb.params ->> 'flops_per_sample')::double precision / 3));
  end if;
  return rid;
end $$;

create or replace function public.myc_reserve(p_node uuid, p_model text, p_expected int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare latest int; l myc_publish_lease;
begin
  perform myc_rl('reserve:' || p_node, 30);
  if p_model not in ('fashion', 'har', 'intent', 'words', 'lm') then return jsonb_build_object('ok', false, 'reason', 'bad model'); end if;
  perform pg_advisory_xact_lock(hashtext('myc_round:' || p_model));
  select max(version) into latest from myc_models where model = p_model;
  if coalesce(latest, -1) <> p_expected then return jsonb_build_object('ok', false, 'reason', 'stale', 'latest', latest); end if;
  if exists (select 1 from myc_candidates where model = p_model and status = 'pending') then return jsonb_build_object('ok', false, 'reason', 'candidate pending'); end if;
  select * into l from myc_publish_lease where model = p_model;
  if l.model is not null and l.until > now() and l.node <> p_node and l.version = p_expected + 1 then
    return jsonb_build_object('ok', false, 'reason', 'busy', 'until', l.until);
  end if;
  -- model językowy: ocena kandydata na 2000 pytaniach trwa kilka–kilkanaście minut na CPU
  insert into myc_publish_lease (model, version, node, until) values (p_model, p_expected + 1, p_node, now() + case when p_model = 'lm' then interval '60 minutes' else interval '3 minutes' end)
    on conflict (model) do update set version = excluded.version, node = excluded.node, until = excluded.until;
  return jsonb_build_object('ok', true, 'version', p_expected + 1);
end $$;

-- Zaufany weryfikator modelu językowego (CI): trafność + perpleksja.
create or replace function public.myc_reeval_trusted_lm(p_key text, p_candidate bigint, p_acc real, p_ppl real, p_sha text, p_n int, p_backend text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t myc_trusted_nodes;
begin
  perform myc_rl('trusted:' || md5(coalesce(p_key, '')), 30);
  select * into t from myc_trusted_nodes where key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if t.node is null then return jsonb_build_object('ok', false, 'reason', 'unknown key'); end if;
  if not exists (select 1 from myc_candidates where id = p_candidate and status = 'pending' and model = 'lm') then return jsonb_build_object('ok', false, 'reason', 'not pending'); end if;
  if p_ppl is null or p_ppl <= 0 then return jsonb_build_object('ok', false, 'reason', 'bad ppl'); end if;
  insert into myc_candidate_evals (candidate_id, node, ip_hash, trusted, acc, sha, n, backend, ppl)
    values (p_candidate, t.node, 'trusted:' || t.label, true, p_acc, p_sha, p_n, left(coalesce(p_backend, 'torch'), 20), p_ppl)
    on conflict (candidate_id, node) do update set acc = excluded.acc, sha = excluded.sha, n = excluded.n, ppl = excluded.ppl, created_at = now();
  return myc_finalize(p_candidate);
end $$;
revoke all on function public.myc_reeval_trusted_lm(text, bigint, real, real, text, int, text) from public;
grant execute on function public.myc_reeval_trusted_lm(text, bigint, real, real, text, int, text) to anon, authenticated;
revoke all on function public.myc_finalize(bigint) from public, anon, authenticated;

-- Nowy punkt odniesienia bramki po zmianie zbioru testowego: zaufany weryfikator przelicza bieżącą (najnowszą)
-- opublikowaną wersję na nowym zbiorze. Poprzednie liczby zostają w meta.rebased (pełna historia, nic nie znika).
create or replace function public.myc_rebase_lm(p_key text, p_version int, p_acc real, p_ppl real, p_correct int, p_sha text, p_n int, p_backend text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t myc_trusted_nodes; es myc_eval_sets; cur myc_models;
begin
  perform myc_rl('trusted:' || md5(coalesce(p_key, '')), 30);
  select * into t from myc_trusted_nodes where key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if t.node is null then return jsonb_build_object('ok', false, 'reason', 'unknown key'); end if;
  perform pg_advisory_xact_lock(hashtext('myc_round:lm'));
  select * into es from myc_eval_sets where model = 'lm';
  if p_sha is distinct from es.sha or p_n is distinct from es.n then return jsonb_build_object('ok', false, 'reason', 'eval set mismatch'); end if;
  select * into cur from myc_models where model = 'lm' order by version desc limit 1;
  if cur.version is distinct from p_version then return jsonb_build_object('ok', false, 'reason', 'not latest'); end if;
  if cur.meta ->> 'eval_sha' = es.sha then return jsonb_build_object('ok', false, 'reason', 'already rebased'); end if;
  if p_ppl is null or p_ppl <= 0 or p_acc < 0 or p_acc > 1 or p_correct is null or p_correct <> round(p_acc::numeric * p_n) then
    return jsonb_build_object('ok', false, 'reason', 'bad values');
  end if;
  update myc_models set acc = p_acc,
    meta = meta || jsonb_build_object('ppl', p_ppl, 'correct', p_correct, 'eval_n', p_n, 'eval_sha', p_sha, 'eval_version', es.version,
      'rebased', coalesce(meta -> 'rebased', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'at', now(), 'by', t.label, 'backend', left(coalesce(p_backend, 'torch'), 30),
        'prev_acc', acc, 'prev_ppl', meta -> 'ppl', 'prev_correct', meta -> 'correct', 'prev_eval_n', coalesce(meta -> 'eval_n', '250'::jsonb),
        'prev_eval_sha', meta -> 'eval_sha', 'acc', p_acc, 'ppl', p_ppl, 'eval_n', p_n)))
    where model = 'lm' and version = cur.version;
  return jsonb_build_object('ok', true, 'version', cur.version, 'acc', p_acc, 'ppl', p_ppl);
end $$;
revoke all on function public.myc_rebase_lm(text, int, real, real, int, text, int, text) from public;
grant execute on function public.myc_rebase_lm(text, int, real, real, int, text, int, text) to anon, authenticated;
