-- Niezależna weryfikacja kandydatów: baza nie ufa trafności zgłoszonej przez agregatora.
-- Agregator zgłasza kandydata (myc_propose). Wersja powstaje dopiero, gdy stały test policzą niezależnie:
--   >= 2 inne węzły z RÓŻNYCH adresów IP (innych niż IP zgłaszającego) albo 1 zaufany węzeł (cron GitHub Actions, klucz).
-- Trafność wersji = najniższa zweryfikowana; rozbieżność z deklaracją > 1 pkt → odrzucenie; potem bramka bez regresji.

alter table public.myc_jobs drop constraint if exists myc_jobs_kind_check;
alter table public.myc_jobs add constraint myc_jobs_kind_check check (kind in ('train', 'eval', 'hparam', 'label', 'verify', 'reeval'));
alter table public.myc_models add column if not exists verifiers jsonb;

create table if not exists public.myc_candidates (
  id bigint generated always as identity primary key,
  model text not null,
  version int not null,
  path text not null,
  acc_claimed real not null,
  val_acc real,
  eval_n int not null,
  eval_sha text not null,
  meta jsonb not null default '{}' check (pg_column_size(meta) < 4000),
  accepted bigint[] not null default '{}',
  rejected bigint[] not null default '{}',
  proposer uuid not null,
  proposer_ip text not null,
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected', 'expired')),
  verified_acc real,
  verifiers jsonb,
  reason text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists myc_candidates_one_pending on public.myc_candidates (model) where status = 'pending';
create table if not exists public.myc_candidate_evals (
  candidate_id bigint not null references public.myc_candidates (id) on delete cascade,
  node uuid not null,
  ip_hash text not null,
  trusted boolean not null default false,
  acc real not null check (acc between 0 and 1),
  sha text not null,
  n int not null,
  backend text,
  created_at timestamptz not null default now(),
  primary key (candidate_id, node)
);
create table if not exists public.myc_trusted_nodes (
  key_hash text primary key,
  node uuid not null,
  label text not null
);
alter table public.myc_candidates enable row level security;
alter table public.myc_candidate_evals enable row level security;
alter table public.myc_trusted_nodes enable row level security;
revoke all on public.myc_candidates, public.myc_candidate_evals, public.myc_trusted_nodes from anon, authenticated;
grant select on public.myc_candidates, public.myc_candidate_evals to anon, authenticated;
drop policy if exists myc_candidates_read on public.myc_candidates;
create policy myc_candidates_read on public.myc_candidates for select using (true);
drop policy if exists myc_candidate_evals_read on public.myc_candidate_evals;
create policy myc_candidate_evals_read on public.myc_candidate_evals for select using (true);
-- myc_trusted_nodes: bez dostępu publicznego (tylko skróty kluczy)

create or replace function public.myc_ip() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select md5('myc-salt-v1' || public.myc_client_ip())
$$;
revoke all on function public.myc_ip() from public, anon, authenticated;

-- Rozstrzygnięcie kandydata (wołane po każdej weryfikacji).
create or replace function public.myc_finalize(p_cand bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c myc_candidates; cur myc_models; latest int; n_tr int; n_ip int; vmin real; vmax_dev real; ver jsonb; why text;
begin
  perform pg_advisory_xact_lock(hashtext('myc_round:' || (select model from myc_candidates where id = p_cand)));
  select * into c from myc_candidates where id = p_cand for update;
  if c.id is null or c.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'not pending'); end if;
  -- kwalifikują się: inny węzeł, inne IP niż zgłaszający, ten sam zbiór testowy
  select count(*) filter (where trusted), count(distinct ip_hash) filter (where not trusted),
         min(acc), max(abs(acc - c.acc_claimed)),
         jsonb_agg(jsonb_build_object('node', node, 'acc', acc, 'trusted', trusted, 'backend', backend) order by created_at)
    into n_tr, n_ip, vmin, vmax_dev, ver
    from myc_candidate_evals e
   where e.candidate_id = c.id and e.node <> c.proposer and (e.trusted or e.ip_hash <> c.proposer_ip)
     and e.sha = c.eval_sha and e.n = c.eval_n;
  if n_tr < 1 and n_ip < 2 then return jsonb_build_object('ok', false, 'reason', 'waiting', 'trusted', n_tr, 'ips', n_ip); end if;
  select max(version) into latest from myc_models where model = c.model;
  select * into cur from myc_models where model = c.model and version = latest;
  if coalesce(latest, -1) + 1 <> c.version then why := 'stale';
  elsif vmax_dev > 0.01 then why := format('claim mismatch: declared %s, verified min %s', round(c.acc_claimed::numeric, 4), round(vmin::numeric, 4));
  -- porównanie w liczbie trafień na stałym zbiorze (odporne na zaokrąglenia klienta)
  elsif cur.acc is not null and round(vmin::numeric * c.eval_n) < round(cur.acc::numeric * c.eval_n) then why := format('regression %s < %s', round(vmin::numeric, 4), round(cur.acc::numeric, 4));
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
           c.meta || jsonb_build_object('eval_n', c.eval_n, 'gate_prev', cur.acc, 'claimed', c.acc_claimed, 'candidate', c.id), c.proposer, ver
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
revoke all on function public.myc_finalize(bigint) from public, anon, authenticated;

-- Zgłoszenie kandydata (zamiast bezpośredniej publikacji). Te same warunki co wcześniej + zadania ponownej oceny.
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
  select * into es from myc_eval_sets where model = p_model;
  if es.model is null or p_eval_n is distinct from es.n or p_eval_sha is distinct from es.sha then
    return jsonb_build_object('ok', false, 'reason', 'eval set mismatch');
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
    if cur.acc is not null and round(p_acc::numeric * p_eval_n) < round(cur.acc::numeric * p_eval_n) then
      insert into myc_model_rejections (model, version, node, acc, cur_acc, val_acc, eval_n, reason, meta)
        values (p_model, p_version, p_node, p_acc, cur.acc, p_val, p_eval_n, format('regression %s < %s', round(p_acc::numeric, 4), round(cur.acc::numeric, 4)), coalesce(p_meta, '{}'));
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

-- Weryfikacja przez zaufany węzeł (cron GitHub Actions): klucz sprawdzany po skrócie sha256.
create or replace function public.myc_reeval_trusted(p_key text, p_candidate bigint, p_acc real, p_sha text, p_n int, p_backend text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t myc_trusted_nodes;
begin
  perform myc_rl('trusted:' || md5(coalesce(p_key, '')), 30);
  select * into t from myc_trusted_nodes where key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if t.node is null then return jsonb_build_object('ok', false, 'reason', 'unknown key'); end if;
  if not exists (select 1 from myc_candidates where id = p_candidate and status = 'pending') then return jsonb_build_object('ok', false, 'reason', 'not pending'); end if;
  insert into myc_candidate_evals (candidate_id, node, ip_hash, trusted, acc, sha, n, backend)
    values (p_candidate, t.node, 'trusted:' || t.label, true, p_acc, p_sha, p_n, left(coalesce(p_backend, 'numpy'), 20))
    on conflict (candidate_id, node) do update set acc = excluded.acc, sha = excluded.sha, n = excluded.n, created_at = now();
  return myc_finalize(p_candidate);
end $$;

-- Pobranie zadania: weryfikacje i ponowne oceny najpierw; ponownej oceny nie dostaje zgłaszający, jego IP ani ten, kto już ocenił.
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
  return query update myc_jobs set status = 'leased', lease_node = p_node, lease_until = now() + interval '3 minutes', attempts = attempts + 1
    where id = j returning *;
end $$;

-- Oddanie wyniku; dla ponownej oceny zapis weryfikacji (węzeł + skrót IP) i próba rozstrzygnięcia kandydata.
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
    insert into myc_candidate_evals (candidate_id, node, ip_hash, acc, sha, n, backend)
      values (cid, p_node, myc_ip(), least(greatest((p_metrics ->> 'acc')::real, 0), 1), coalesce(p_metrics ->> 'eval_sha', ''), coalesce((p_metrics ->> 'n')::int, 0), p_backend)
      on conflict (candidate_id, node) do nothing;
    perform myc_finalize(cid);
  end if;
  if jb.kind = 'train' and rid % 4 = 0 then
    insert into myc_jobs (model, version, kind, params)
      values (jb.model, jb.version, 'verify', jsonb_build_object('result', rid, 'exclude', p_node::text,
              'flops_per_sample', (jb.params ->> 'flops_per_sample')::double precision / 3));
  end if;
  return rid;
end $$;

-- Rezerwacja: nie, gdy kandydat czeka na weryfikację.
create or replace function public.myc_reserve(p_node uuid, p_model text, p_expected int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare latest int; l myc_publish_lease;
begin
  perform myc_rl('reserve:' || p_node, 30);
  if p_model not in ('fashion', 'har', 'intent', 'words') then return jsonb_build_object('ok', false, 'reason', 'bad model'); end if;
  perform pg_advisory_xact_lock(hashtext('myc_round:' || p_model));
  select max(version) into latest from myc_models where model = p_model;
  if coalesce(latest, -1) <> p_expected then return jsonb_build_object('ok', false, 'reason', 'stale', 'latest', latest); end if;
  if exists (select 1 from myc_candidates where model = p_model and status = 'pending') then return jsonb_build_object('ok', false, 'reason', 'candidate pending'); end if;
  select * into l from myc_publish_lease where model = p_model;
  if l.model is not null and l.until > now() and l.node <> p_node and l.version = p_expected + 1 then
    return jsonb_build_object('ok', false, 'reason', 'busy', 'until', l.until);
  end if;
  insert into myc_publish_lease (model, version, node, until) values (p_model, p_expected + 1, p_node, now() + interval '3 minutes')
    on conflict (model) do update set version = excluded.version, node = excluded.node, until = excluded.until;
  return jsonb_build_object('ok', true, 'version', p_expected + 1);
end $$;

-- Runda: nie, gdy kandydat czeka.
create or replace function public.myc_post_round(p_node uuid, p_model text, p_version int, p_jobs jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare latest int; n int;
begin
  perform myc_rl('round:' || p_node, 12);
  perform pg_advisory_xact_lock(hashtext('myc_round:' || p_model));
  select max(version) into latest from myc_models where model = p_model;
  if latest is null or latest <> p_version then return -1; end if;
  if exists (select 1 from myc_candidates where model = p_model and status = 'pending')
     or exists (select 1 from myc_jobs where model = p_model and version = p_version and kind = 'train' and status in ('open', 'leased'))
     or exists (select 1 from myc_results where model = p_model and version = p_version and kind in ('train', 'hparam') and status = 'pending') then
    return 0;
  end if;
  if jsonb_typeof(p_jobs) <> 'array' or jsonb_array_length(p_jobs) > 48 then raise exception 'myc: bad jobs'; end if;
  insert into myc_jobs (model, version, kind, params)
    select p_model, p_version, j ->> 'kind', coalesce(j -> 'params', '{}')
    from jsonb_array_elements(p_jobs) j where j ->> 'kind' in ('train', 'eval', 'hparam', 'label');
  get diagnostics n = row_count;
  update myc_jobs set status = 'expired' where model = p_model and version < p_version and status in ('open', 'leased');
  return n;
end $$;

-- Sprzątanie: + kandydaci bez weryfikacji przez 6 h wygasają (aktualizacje rundy odrzucone → nowa runda).
create or replace function public.myc_sweep() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int; b int; c int; d int; e int; cr record;
begin
  update myc_jobs set status = 'open', lease_node = null, lease_until = null
   where status = 'leased' and lease_until < now() - interval '30 seconds' and attempts < 5;
  get diagnostics a = row_count;
  update myc_jobs set status = 'expired'
   where status in ('open', 'leased') and attempts >= 5 and (lease_until is null or lease_until < now());
  get diagnostics b = row_count;
  update myc_jobs j set status = 'expired'
   where j.status in ('open', 'leased') and j.kind <> 'reeval'
     and j.version < (select max(version) from myc_models m where m.model = j.model);
  get diagnostics c = row_count;
  e := 0;
  for cr in update myc_candidates set status = 'expired', reason = 'no independent verification in 6 h', decided_at = now()
             where status = 'pending' and created_at < now() - interval '6 hours' returning model, version loop
    update myc_results set status = 'rejected' where model = cr.model and version = cr.version - 1 and kind in ('train', 'hparam') and status = 'pending';
    e := e + 1;
  end loop;
  update myc_jobs set status = 'expired' where kind = 'reeval' and status in ('open', 'leased')
    and not exists (select 1 from myc_candidates c2 where c2.id = (myc_jobs.params ->> 'candidate')::bigint and c2.status = 'pending');
  delete from myc_publish_lease where until < now() - interval '5 minutes';
  delete from myc_rate where minute < now() - interval '2 hours';
  get diagnostics d = row_count;
  return jsonb_build_object('reopened', a, 'expired_attempts', b, 'expired_stale', c, 'rate_rows', d, 'expired_candidates', e);
end $$;

drop function if exists public.myc_publish_v2(uuid, text, int, text, real, real, int, text, jsonb, bigint[], bigint[]);
revoke all on function public.myc_propose(uuid, text, int, text, real, real, int, text, jsonb, bigint[], bigint[]),
  public.myc_reeval_trusted(text, bigint, real, text, int, text) from public;
grant execute on function public.myc_propose(uuid, text, int, text, real, real, int, text, jsonb, bigint[], bigint[]),
  public.myc_reeval_trusted(text, bigint, real, text, int, text) to anon, authenticated;
