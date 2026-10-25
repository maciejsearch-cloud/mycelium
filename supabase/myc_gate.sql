-- Bramka bez regresji + atomowa rezerwacja wersji (CAS) + sprzątanie dzierżaw.
-- Wersja v+1 modelu globalnego powstaje tylko, gdy jej trafność na STAŁYM odłożonym teście (ten sam zbiór,
-- sprawdzany odciskiem etykiet i liczbą próbek) jest >= trafności bieżącej wersji (tolerancja 0 – bez regresji).
-- Odrzucone kandydatury trafiają do myc_model_rejections. Stara funkcja myc_publish jest usunięta,
-- więc bramki nie da się obejść ze starego klienta.

create table if not exists public.myc_eval_sets (
  model text primary key check (model in ('fashion', 'har', 'intent', 'words')),
  n int not null check (n > 0),
  sha text not null check (sha ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create table if not exists public.myc_publish_lease (
  model text primary key,
  version int not null,
  node uuid not null,
  until timestamptz not null
);
create table if not exists public.myc_model_rejections (
  id bigint generated always as identity primary key,
  model text not null,
  version int not null,
  node uuid,
  acc real,
  cur_acc real,
  val_acc real,
  eval_n int,
  reason text not null check (char_length(reason) < 200),
  meta jsonb not null default '{}' check (pg_column_size(meta) < 4000),
  created_at timestamptz not null default now()
);
create index if not exists myc_model_rejections_mv on public.myc_model_rejections (model, created_at desc);
alter table public.myc_eval_sets enable row level security;
alter table public.myc_publish_lease enable row level security;
alter table public.myc_model_rejections enable row level security;
revoke all on public.myc_eval_sets, public.myc_publish_lease, public.myc_model_rejections from anon, authenticated;
grant select on public.myc_eval_sets, public.myc_publish_lease, public.myc_model_rejections to anon, authenticated;
drop policy if exists myc_eval_sets_read on public.myc_eval_sets;
create policy myc_eval_sets_read on public.myc_eval_sets for select using (true);
drop policy if exists myc_publish_lease_read on public.myc_publish_lease;
create policy myc_publish_lease_read on public.myc_publish_lease for select using (true);
drop policy if exists myc_model_rejections_read on public.myc_model_rejections;
create policy myc_model_rejections_read on public.myc_model_rejections for select using (true);

-- Czy wagi już są w Storage (unika POST duplikatu → 400/409 w konsoli)
create or replace function public.myc_weights_exist(p_path text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from storage.objects where bucket_id = 'myc-models' and name = p_path)
$$;

-- Sprzątanie: wygasłe dzierżawy wracają do puli (maks. 5 prób), zadania starych wersji wygasają, stare liczniki limitera znikają.
create or replace function public.myc_sweep() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int; b int; c int; d int;
begin
  update myc_jobs set status = 'open', lease_node = null, lease_until = null
   where status = 'leased' and lease_until < now() - interval '30 seconds' and attempts < 5;
  get diagnostics a = row_count;
  update myc_jobs set status = 'expired'
   where status in ('open', 'leased') and attempts >= 5 and (lease_until is null or lease_until < now());
  get diagnostics b = row_count;
  update myc_jobs j set status = 'expired'
   where j.status in ('open', 'leased')
     and j.version < (select max(version) from myc_models m where m.model = j.model);
  get diagnostics c = row_count;
  delete from myc_publish_lease where until < now() - interval '5 minutes';
  delete from myc_rate where minute < now() - interval '2 hours';
  get diagnostics d = row_count;
  return jsonb_build_object('reopened', a, 'expired_attempts', b, 'expired_stale', c, 'rate_rows', d);
end $$;

-- CAS: zarezerwuj publikację wersji p_expected+1 (tylko gdy ostatnia = p_expected i nikt inny nie ma ważnej rezerwacji).
create or replace function public.myc_reserve(p_node uuid, p_model text, p_expected int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare latest int; l myc_publish_lease;
begin
  perform myc_rl('reserve:' || p_node, 30);
  if p_model not in ('fashion', 'har', 'intent', 'words') then return jsonb_build_object('ok', false, 'reason', 'bad model'); end if;
  perform pg_advisory_xact_lock(hashtext('myc_round:' || p_model));
  select max(version) into latest from myc_models where model = p_model;
  if coalesce(latest, -1) <> p_expected then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'latest', latest);
  end if;
  select * into l from myc_publish_lease where model = p_model;
  if l.model is not null and l.until > now() and l.node <> p_node and l.version = p_expected + 1 then
    return jsonb_build_object('ok', false, 'reason', 'busy', 'until', l.until);
  end if;
  insert into myc_publish_lease (model, version, node, until) values (p_model, p_expected + 1, p_node, now() + interval '3 minutes')
    on conflict (model) do update set version = excluded.version, node = excluded.node, until = excluded.until;
  return jsonb_build_object('ok', true, 'version', p_expected + 1);
end $$;

-- Publikacja z bramką. Zwraca {ok, reason}; przewidywalne sytuacje (wyścig, regresja) nie są wyjątkami HTTP.
create or replace function public.myc_publish_v2(p_node uuid, p_model text, p_version int, p_path text, p_acc real, p_val real,
  p_eval_n int, p_eval_sha text, p_meta jsonb, p_accepted bigint[], p_rejected bigint[])
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare latest int; cur myc_models; l myc_publish_lease; es myc_eval_sets; ok int; why text;
begin
  perform myc_rl('publish:' || p_node, 12);
  perform pg_advisory_xact_lock(hashtext('myc_round:' || p_model));
  select max(version) into latest from myc_models where model = p_model;
  if coalesce(latest, -1) + 1 <> p_version then return jsonb_build_object('ok', false, 'reason', 'stale', 'latest', latest); end if;
  select * into l from myc_publish_lease where model = p_model;
  if l.model is null or l.node <> p_node or l.version <> p_version or l.until < now() - interval '30 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'no reservation');
  end if;
  if p_path !~ ('^' || p_model || '/v' || p_version || '-[0-9a-f]{8}\.bin$') then return jsonb_build_object('ok', false, 'reason', 'bad path'); end if;
  if not exists (select 1 from storage.objects where bucket_id = 'myc-models' and name = p_path) then
    return jsonb_build_object('ok', false, 'reason', 'weights not uploaded');
  end if;
  if p_acc is null or p_acc < 0 or p_acc > 1 then return jsonb_build_object('ok', false, 'reason', 'bad acc'); end if;
  -- stały zbiór ewaluacyjny: liczba próbek i odcisk etykiet muszą się zgadzać
  select * into es from myc_eval_sets where model = p_model;
  if es.model is null then return jsonb_build_object('ok', false, 'reason', 'eval set not registered'); end if;
  if p_eval_n is distinct from es.n or p_eval_sha is distinct from es.sha then why := 'eval set mismatch'; end if;
  if p_version > 0 then
    select count(*) into ok from myc_results
      where id = any (p_accepted) and model = p_model and version = latest and kind in ('train', 'hparam') and status = 'pending';
    if ok < 3 or ok <> cardinality(p_accepted) then
      delete from myc_publish_lease where model = p_model;
      return jsonb_build_object('ok', false, 'reason', 'need >= 3 valid pending updates');
    end if;
    select * into cur from myc_models where model = p_model and version = latest;
    -- bramka bez regresji (tolerancja 0 na stałym teście)
    if why is null and cur.acc is not null and p_acc < cur.acc then
      why := format('regression %s < %s', round(p_acc::numeric, 4), round(cur.acc::numeric, 4));
    end if;
  end if;
  if why is not null then
    insert into myc_model_rejections (model, version, node, acc, cur_acc, val_acc, eval_n, reason, meta)
      values (p_model, p_version, p_node, p_acc, cur.acc, p_val, p_eval_n, why, coalesce(p_meta, '{}'));
    -- aktualizacje rundy zużyte: odrzucone, otwarte zadania rundy wygasają → można ogłosić kolejną rundę tej wersji
    update myc_results set status = 'rejected'
      where model = p_model and version = coalesce(latest, -1) and kind in ('train', 'hparam') and status = 'pending';
    update myc_jobs set status = 'expired'
      where model = p_model and version = coalesce(latest, -1) and kind in ('train', 'hparam', 'verify') and status in ('open', 'leased');
    delete from myc_publish_lease where model = p_model;
    return jsonb_build_object('ok', false, 'reason', why, 'cur_acc', cur.acc);
  end if;
  insert into myc_models (model, version, path, acc, val_acc, n_updates, n_rejected, samples, flops, meta, created_by)
    select p_model, p_version, p_path, p_acc, p_val, coalesce(cardinality(p_accepted), 0), coalesce(cardinality(p_rejected), 0),
           coalesce(sum(samples), 0), coalesce(sum(flops), 0), coalesce(p_meta, '{}') || jsonb_build_object('eval_n', p_eval_n, 'gate_prev', cur.acc), p_node
    from myc_results where id = any (coalesce(p_accepted, '{}'));
  update myc_results set status = 'accepted' where id = any (coalesce(p_accepted, '{}'));
  update myc_results set status = 'rejected' where id = any (coalesce(p_rejected, '{}')) and status = 'pending';
  update myc_jobs set status = 'expired' where model = p_model and version < p_version and status in ('open', 'leased');
  update myc_results set payload = null where model = p_model and version < p_version - 1 and payload is not null;
  delete from myc_publish_lease where model = p_model;
  return jsonb_build_object('ok', true, 'version', p_version);
end $$;

-- Runda: ponownie dozwolona dla tej samej wersji, gdy poprzednia została zużyta (brak otwartych zadań i oczekujących wyników).
-- Przewidywalne sytuacje zwracają 0/-1 zamiast wyjątku (bez 409 w konsoli).
create or replace function public.myc_post_round(p_node uuid, p_model text, p_version int, p_jobs jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare latest int; n int;
begin
  perform myc_rl('round:' || p_node, 12);
  perform pg_advisory_xact_lock(hashtext('myc_round:' || p_model));
  select max(version) into latest from myc_models where model = p_model;
  if latest is null or latest <> p_version then return -1; end if;
  if exists (select 1 from myc_jobs where model = p_model and version = p_version and kind = 'train' and status in ('open', 'leased'))
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

-- Oddanie wyniku: brak ważnej dzierżawy → -1 (bez wyjątku; np. zadanie wygasło po nowej wersji).
create or replace function public.myc_submit(p_job bigint, p_node uuid, p_contrib uuid, p_payload text, p_metrics jsonb,
  p_samples int, p_flops double precision, p_ms int, p_backend text)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare jb myc_jobs; rid bigint;
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
  if jb.kind = 'train' and rid % 4 = 0 then
    insert into myc_jobs (model, version, kind, params)
      values (jb.model, jb.version, 'verify', jsonb_build_object('result', rid, 'exclude', p_node::text,
              'flops_per_sample', (jb.params ->> 'flops_per_sample')::double precision / 3));
  end if;
  return rid;
end $$;

-- Pobranie zadania: najpierw sprzątanie wygasłych dzierżaw.
create or replace function public.myc_claim(p_node uuid, p_models text[], p_kinds text[])
returns setof public.myc_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare j bigint;
begin
  perform myc_rl('claim:' || p_node, 150);
  update myc_jobs set status = 'expired' where status in ('open', 'leased') and attempts >= 5 and (lease_until is null or lease_until < now());
  select id into j from myc_jobs
   where (status = 'open' or (status = 'leased' and lease_until < now()))
     and model = any (p_models) and kind = any (p_kinds)
     and coalesce(params ->> 'exclude', '') <> p_node::text
     and version = (select max(version) from myc_models m where m.model = myc_jobs.model)
   order by (kind = 'verify') desc, id
   limit 1 for update skip locked;
  if j is null then return; end if;
  return query update myc_jobs set status = 'leased', lease_node = p_node, lease_until = now() + interval '3 minutes', attempts = attempts + 1
    where id = j returning *;
end $$;

drop function if exists public.myc_publish(uuid, text, int, text, real, real, jsonb, bigint[], bigint[]);
revoke all on function public.myc_weights_exist(text), public.myc_sweep(), public.myc_reserve(uuid, text, int),
  public.myc_publish_v2(uuid, text, int, text, real, real, int, text, jsonb, bigint[], bigint[]) from public;
grant execute on function public.myc_weights_exist(text), public.myc_reserve(uuid, text, int),
  public.myc_publish_v2(uuid, text, int, text, real, real, int, text, jsonb, bigint[], bigint[]) to anon, authenticated;
-- myc_sweep: tylko harmonogram (pg_cron) i właściciel bazy
