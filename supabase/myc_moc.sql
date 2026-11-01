-- Moc (1.11.2026): telemetria węzłów do zakładki „Moc”. Węzeł wysyła co minutę uśrednione liczby (bez nazwy komputera
-- i bez IP w tabeli). Surowe wiersze 48 h, potem godzinowe średnie 30 dni (myc_moc_rollup, pg_cron co godzinę).
create table if not exists public.myc_moc (
  id bigserial primary key,
  node_id uuid not null,
  at timestamptz not null default now(),
  iv int not null check (iv between 10 and 900),
  cpu real check (cpu between 0 and 100),
  cpu_max real check (cpu_max between 0 and 100),
  cpu_proc real check (cpu_proc between 0 and 100),
  gpu real check (gpu between 0 and 100),
  mem real check (mem between 0 and 100),
  rss_mb int check (rss_mb between 0 and 1048576),
  threads int check (threads between 1 and 1024),
  device text not null check (device in ('cpu', 'directml', 'cuda')),
  work jsonb not null default '{}' check (jsonb_typeof(work) = 'object' and pg_column_size(work) < 600)
);
create index if not exists myc_moc_at on public.myc_moc (at desc);
create index if not exists myc_moc_node_at on public.myc_moc (node_id, at desc);
create table if not exists public.myc_moc_hour (
  node_id uuid not null,
  hour timestamptz not null,
  n int not null,
  cpu real, cpu_max real, cpu_proc real, gpu real, mem real, rss_mb int, threads int,
  device text,
  work jsonb not null default '{}',
  primary key (node_id, hour)
);
alter table public.myc_moc enable row level security;
alter table public.myc_moc_hour enable row level security;
revoke all on public.myc_moc, public.myc_moc_hour from anon, authenticated;
grant select on public.myc_moc, public.myc_moc_hour to anon, authenticated;
drop policy if exists myc_moc_read on public.myc_moc;
create policy myc_moc_read on public.myc_moc for select using (true);
drop policy if exists myc_moc_hour_read on public.myc_moc_hour;
create policy myc_moc_hour_read on public.myc_moc_hour for select using (true);

-- zapis tylko przez tę funkcję: limit (myc_rl: węzeł i IP), zakresy, dozwolone klucze pracy, ≥ 45 s od poprzedniego
create or replace function public.myc_moc_push(p_node uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare w jsonb := '{}'; k text; v numeric; last timestamptz;
begin
  perform myc_rl('moc:' || p_node, 3);
  if jsonb_typeof(p) <> 'object' or pg_column_size(p) > 2000 then return jsonb_build_object('ok', false, 'reason', 'bad'); end if;
  select max(at) into last from myc_moc where node_id = p_node and at > now() - interval '45 seconds';
  if last is not null then return jsonb_build_object('ok', false, 'reason', 'too often'); end if;
  if (select count(*) from myc_moc where at > now() - interval '1 minute') > 300 then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  for k, v in select key, (value #>> '{}')::numeric from jsonb_each(coalesce(p->'work', '{}'))
    where key in ('lm_train','lm_distill','lm_eval','lm_aggregate','rozbior','taxo','verify','images','wallet','p71')
      and jsonb_typeof(value) = 'number' loop
    w := w || jsonb_build_object(k, least(greatest(v, 0), 1800));
  end loop;
  insert into myc_moc (node_id, iv, cpu, cpu_max, cpu_proc, gpu, mem, rss_mb, threads, device, work)
  values (p_node, least(greatest(coalesce((p->>'iv')::int, 60), 10), 900),
    (p->>'cpu')::real, (p->>'cpu_max')::real, (p->>'cpu_proc')::real, (p->>'gpu')::real, (p->>'mem')::real,
    (p->>'rss_mb')::int, coalesce((p->>'threads')::int, 1),
    case when p->>'device' in ('cpu', 'directml', 'cuda') then p->>'device' else 'cpu' end, w);
  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', false, 'reason', 'invalid');
end $$;
revoke execute on function public.myc_moc_push(uuid, jsonb) from public;
grant execute on function public.myc_moc_push(uuid, jsonb) to anon, authenticated;

create or replace function public.myc_moc_rollup() returns void language sql security definer set search_path = public as $$
  with b as (
    select node_id, date_trunc('hour', at) h, count(*) n, avg(cpu) cpu, max(cpu_max) cpu_max, avg(cpu_proc) cpu_proc,
           avg(gpu) gpu, avg(mem) mem, max(rss_mb) rss_mb, max(threads) threads, max(device) device
    from myc_moc where at < date_trunc('hour', now()) group by 1, 2),
  w as (
    select node_id, h, jsonb_object_agg(k, s) work from (
      select m.node_id, date_trunc('hour', m.at) h, e.key k, round(sum((e.value #>> '{}')::numeric), 1) s
      from myc_moc m, jsonb_each(m.work) e where m.at < date_trunc('hour', now()) group by 1, 2, 3) x
    group by 1, 2)
  insert into myc_moc_hour (node_id, hour, n, cpu, cpu_max, cpu_proc, gpu, mem, rss_mb, threads, device, work)
  select b.node_id, b.h, b.n, b.cpu, b.cpu_max, b.cpu_proc, b.gpu, b.mem, b.rss_mb, b.threads, b.device, coalesce(w.work, '{}')
  from b left join w using (node_id, h)
  on conflict (node_id, hour) do update set n = excluded.n, cpu = excluded.cpu, cpu_max = excluded.cpu_max,
    cpu_proc = excluded.cpu_proc, gpu = excluded.gpu, mem = excluded.mem, rss_mb = excluded.rss_mb,
    threads = excluded.threads, device = excluded.device, work = excluded.work;
  delete from myc_moc where at < now() - interval '48 hours';
  delete from myc_moc_hour where hour < now() - interval '30 days';
$$;
revoke execute on function public.myc_moc_rollup() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'myc_moc_rollup';
select cron.schedule('myc_moc_rollup', '7 * * * *', 'select public.myc_moc_rollup()');
