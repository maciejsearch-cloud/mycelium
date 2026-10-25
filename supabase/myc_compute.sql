-- Rozproszone obliczenia grzybni: wersjonowany model globalny, kolejka zadań z dzierżawą, wyniki, weryfikacja.
-- Wszystkie zapisy tylko przez funkcje RPC (security definer) z limitami; tabele są publiczne do odczytu.

create table if not exists public.myc_models (
  model text not null check (model in ('fashion', 'har', 'intent', 'words')),
  version int not null check (version between 0 and 1000000),
  path text not null check (char_length(path) < 120),
  acc real check (acc between 0 and 1),          -- dokładność na odłożonym teście (liczona przez agregatora)
  val_acc real check (val_acc between 0 and 1),
  n_updates int not null default 0,
  n_rejected int not null default 0,
  samples bigint not null default 0,
  flops double precision not null default 0,
  meta jsonb not null default '{}' check (pg_column_size(meta) < 4000),
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (model, version)
);

create table if not exists public.myc_jobs (
  id bigint generated always as identity primary key,
  model text not null,
  version int not null,
  kind text not null check (kind in ('train', 'eval', 'hparam', 'label', 'verify')),
  params jsonb not null default '{}' check (pg_column_size(params) < 2000),
  status text not null default 'open' check (status in ('open', 'leased', 'done', 'expired')),
  lease_node uuid,
  lease_until timestamptz,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists myc_jobs_open_idx on public.myc_jobs (status, id) where status in ('open', 'leased');
create index if not exists myc_jobs_mv_idx on public.myc_jobs (model, version, kind);

create table if not exists public.myc_results (
  id bigint generated always as identity primary key,
  job_id bigint not null references public.myc_jobs (id) on delete cascade,
  model text not null,
  version int not null,
  kind text not null,
  node_id uuid not null,
  contributor_id uuid,
  payload text check (payload is null or (char_length(payload) <= 400000 and payload ~ '^[A-Za-z0-9+/=]*$')),
  metrics jsonb not null default '{}' check (pg_column_size(metrics) < 3000 and jsonb_typeof(metrics) = 'object'),
  samples int not null check (samples between 0 and 10000000),
  flops double precision not null check (flops >= 0 and flops < 1e16),
  ms int not null check (ms between 0 and 3600000),
  backend text not null check (backend in ('webgpu', 'webgl', 'wasm', 'cpu', 'directml')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'info')),
  created_at timestamptz not null default now()
);
create index if not exists myc_results_mv_idx on public.myc_results (model, version, kind, status);
create index if not exists myc_results_contrib_idx on public.myc_results (contributor_id);

alter table public.myc_models enable row level security;
alter table public.myc_jobs enable row level security;
alter table public.myc_results enable row level security;
revoke all on public.myc_models, public.myc_jobs, public.myc_results from anon, authenticated;
grant select on public.myc_models, public.myc_jobs, public.myc_results to anon, authenticated;
drop policy if exists myc_models_read on public.myc_models;
create policy myc_models_read on public.myc_models for select using (true);
drop policy if exists myc_jobs_read on public.myc_jobs;
create policy myc_jobs_read on public.myc_jobs for select using (true);
drop policy if exists myc_results_read on public.myc_results;
create policy myc_results_read on public.myc_results for select using (true);

-- limiter na kubełek (węzeł/IP) i minutę
create or replace function public.myc_rl(p_bucket text, p_lim int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ip text := public.myc_client_ip();
  m timestamptz := date_trunc('minute', now());
  n1 int; n2 int;
begin
  insert into myc_rate as r (bucket, minute, n) values (p_bucket, m, 1)
    on conflict (bucket, minute) do update set n = r.n + 1 returning r.n into n1;
  insert into myc_rate as r (bucket, minute, n) values (split_part(p_bucket, ':', 1) || ':ip:' || md5('myc-salt-v1' || ip), m, 1)
    on conflict (bucket, minute) do update set n = r.n + 1 returning r.n into n2;
  if n1 > p_lim or n2 > p_lim * 6 then raise exception 'myc: rate limit' using errcode = 'PT429'; end if;
end $$;
revoke all on function public.myc_rl(text, int) from public, anon, authenticated;

-- Pobierz zadanie (dzierżawa 3 min; po wygaśnięciu wraca do puli, maks. 5 prób). Nie daje weryfikacji autorowi.
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
   order by (kind = 'verify') desc, id
   limit 1 for update skip locked;
  if j is null then return; end if;
  return query update myc_jobs set status = 'leased', lease_node = p_node, lease_until = now() + interval '3 minutes', attempts = attempts + 1
    where id = j returning *;
end $$;

-- Zwróć wynik (tylko właściciel ważnej dzierżawy). 1/4 aktualizacji treningowych dostaje zadanie weryfikacji na innym węźle.
create or replace function public.myc_submit(p_job bigint, p_node uuid, p_contrib uuid, p_payload text, p_metrics jsonb,
  p_samples int, p_flops double precision, p_ms int, p_backend text)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare jb myc_jobs; rid bigint;
begin
  perform myc_rl('submit:' || p_node, 120);
  select * into jb from myc_jobs where id = p_job for update;
  if jb.id is null or jb.status <> 'leased' or jb.lease_node <> p_node or jb.lease_until < now() - interval '30 seconds' then
    raise exception 'myc: no valid lease' using errcode = 'PT409';
  end if;
  -- sufit FLOP-ów: deklaracja nie może przekraczać 2× kosztu modelu × próbki (chroni ranking wkładu)
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

-- Ogłoś rundę dla najnowszej wersji (raz na wersję; maks. 48 zadań).
create or replace function public.myc_post_round(p_node uuid, p_model text, p_version int, p_jobs jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare latest int; n int;
begin
  perform myc_rl('round:' || p_node, 12);
  select max(version) into latest from myc_models where model = p_model;
  if latest is null or latest <> p_version then raise exception 'myc: stale version' using errcode = 'PT409'; end if;
  perform pg_advisory_xact_lock(hashtext('myc_round:' || p_model));
  if exists (select 1 from myc_jobs where model = p_model and version = p_version and kind = 'train') then return 0; end if;
  if jsonb_typeof(p_jobs) <> 'array' or jsonb_array_length(p_jobs) > 48 then raise exception 'myc: bad jobs'; end if;
  insert into myc_jobs (model, version, kind, params)
    select p_model, p_version, j ->> 'kind', coalesce(j -> 'params', '{}')
    from jsonb_array_elements(p_jobs) j where j ->> 'kind' in ('train', 'eval', 'hparam', 'label');
  get diagnostics n = row_count;
  update myc_jobs set status = 'expired' where model = p_model and version < p_version and status in ('open', 'leased');
  return n;
end $$;

-- Opublikuj nową wersję modelu globalnego (agregacja FedAvg/FedProx po walidacji). Wymaga >= 3 przyjętych aktualizacji.
create or replace function public.myc_publish(p_node uuid, p_model text, p_version int, p_path text, p_acc real, p_val real,
  p_meta jsonb, p_accepted bigint[], p_rejected bigint[])
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare latest int; ok int;
begin
  perform myc_rl('publish:' || p_node, 12);
  perform pg_advisory_xact_lock(hashtext('myc_round:' || p_model));
  select max(version) into latest from myc_models where model = p_model;
  if coalesce(latest, -1) + 1 <> p_version then return false; end if;
  if p_path !~ ('^' || p_model || '/v' || p_version || '-[0-9a-f]{8}\.bin$') then raise exception 'myc: bad path'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'myc-models' and name = p_path) then raise exception 'myc: weights not uploaded'; end if;
  if p_version > 0 then
    select count(*) into ok from myc_results
      where id = any (p_accepted) and model = p_model and version = latest and kind in ('train', 'hparam') and status = 'pending';
    if ok < 3 or ok <> cardinality(p_accepted) then raise exception 'myc: need >= 3 valid pending updates'; end if;
  end if;
  insert into myc_models (model, version, path, acc, val_acc, n_updates, n_rejected, samples, flops, meta, created_by)
    select p_model, p_version, p_path, p_acc, p_val, coalesce(cardinality(p_accepted), 0), coalesce(cardinality(p_rejected), 0),
           coalesce(sum(samples), 0), coalesce(sum(flops), 0), coalesce(p_meta, '{}'), p_node
    from myc_results where id = any (coalesce(p_accepted, '{}'));
  update myc_results set status = 'accepted' where id = any (coalesce(p_accepted, '{}'));
  update myc_results set status = 'rejected' where id = any (coalesce(p_rejected, '{}')) and status = 'pending';
  update myc_jobs set status = 'expired' where model = p_model and version < p_version and status in ('open', 'leased');
  -- oszczędność miejsca: delty starszych wersji usuwamy (metryki i wkład zostają)
  update myc_results set payload = null where model = p_model and version < p_version - 1 and payload is not null;
  return true;
end $$;

-- Wkład obliczeniowy (pod przyszłe nagrody): próbki, FLOP-y, GPU vs CPU, przyjęte/odrzucone.
create or replace function public.myc_compute_stats()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'contributors', coalesce((select jsonb_agg(c order by c.flops desc) from (
      select contributor_id, count(*)::int jobs, sum(samples)::bigint samples, sum(flops) flops,
             sum(flops) filter (where backend in ('webgpu', 'webgl', 'directml')) gpu_flops,
             sum(flops) filter (where backend in ('wasm', 'cpu')) cpu_flops,
             count(*) filter (where status = 'accepted')::int accepted, count(*) filter (where status = 'rejected')::int rejected,
             max(created_at) last
      from myc_results group by contributor_id order by sum(flops) desc limit 100) c), '[]'),
    'hourly', coalesce((select jsonb_agg(h order by h.t) from (
      select date_trunc('hour', created_at) t, sum(samples)::bigint samples, sum(flops) flops,
             sum(flops) filter (where backend in ('webgpu', 'webgl', 'directml')) gpu_flops
      from myc_results where created_at > now() - interval '14 days' group by 1) h), '[]'),
    'backends', coalesce((select jsonb_object_agg(backend, jsonb_build_object('jobs', n, 'samples', s, 'ms', ms, 'flops', f)) from (
      select backend, count(*) n, sum(samples) s, sum(ms) ms, sum(flops) f from myc_results where kind in ('train', 'hparam') group by backend) b), '{}'),
    'queue', (select jsonb_build_object('open', count(*) filter (where status = 'open'), 'leased', count(*) filter (where status = 'leased' and lease_until > now()),
              'done', count(*) filter (where status = 'done')) from myc_jobs where created_at > now() - interval '2 days')
  )
$$;

revoke all on function public.myc_claim(uuid, text[], text[]), public.myc_submit(bigint, uuid, uuid, text, jsonb, int, double precision, int, text),
  public.myc_post_round(uuid, text, int, jsonb), public.myc_publish(uuid, text, int, text, real, real, jsonb, bigint[], bigint[]),
  public.myc_compute_stats() from public;
grant execute on function public.myc_claim(uuid, text[], text[]), public.myc_submit(bigint, uuid, uuid, text, jsonb, int, double precision, int, text),
  public.myc_post_round(uuid, text, int, jsonb), public.myc_publish(uuid, text, int, text, real, real, jsonb, bigint[], bigint[]),
  public.myc_compute_stats() to anon, authenticated;

-- Wagi modelu globalnego: publiczny kubełek Storage, tylko dopisywanie (bez nadpisywania i usuwania).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('myc-models', 'myc-models', true, 4194304, array['application/octet-stream'])
  on conflict (id) do update set public = true, file_size_limit = 4194304, allowed_mime_types = array['application/octet-stream'];
drop policy if exists myc_models_upload on storage.objects;
create policy myc_models_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'myc-models' and name ~ '^(fashion|har|intent|words)/v[0-9]{1,6}-[0-9a-f]{8}\.bin$');
drop policy if exists myc_models_read_obj on storage.objects;
create policy myc_models_read_obj on storage.objects for select to anon, authenticated using (bucket_id = 'myc-models');
