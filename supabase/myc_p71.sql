-- Bitcoin Puzzle #71 – koordynacja zakresów przeszukiwania (docs/puzzle71.md).
-- Przestrzeń 2^70..2^71-1 dzielona na 2^38 paczek po 2^32 kluczy; paczka idx zaczyna się od 2^70 + idx·2^32.
-- Serwer losuje paczki bez powtórzeń, węzły raportują wynik podpisem Ed25519 (klucz z myc_node_keys).
-- Uczciwość: XOR wszystkich hash160 w paczce; ok. 1 na 20 przydziałów to ponowne przeliczenie cudzej paczki.
-- Tabele bez polityk RLS = klucz publiczny ich nie czyta; publiczne są tylko sumy z myc_p71_stats().
-- Trafienie: do bazy trafia WYŁĄCZNIE szyfrogram (klucz publiczny właściciela) – myc_p71_hits bez odczytu publicznego.

create table if not exists public.myc_p71_chunks (
  idx bigint primary key check (idx >= 0 and idx < 274877906944),
  node_id uuid not null,
  status smallint not null default 0 check (status in (0, 1, 2)),  -- 0 przydzielona, 1 zrobiona, 2 sporna
  claimed_at timestamptz not null default now(),
  done_at timestamptz,
  keys bigint,
  ms bigint,
  xor text check (xor ~ '^[0-9a-f]{40}$'),
  backend text check (length(backend) <= 16),
  recheck_node uuid,
  recheck_claimed_at timestamptz,
  recheck_ok boolean,
  recheck_at timestamptz
);
create index if not exists myc_p71_chunks_node on public.myc_p71_chunks (node_id, status);
create index if not exists myc_p71_chunks_rc on public.myc_p71_chunks (recheck_node) where recheck_node is not null;
alter table public.myc_p71_chunks enable row level security;

create table if not exists public.myc_p71_nodes (
  node_id uuid primary key,
  rate real not null default 0,          -- klucze/s z ostatniego raportu węzła
  pct real,                              -- udział mocy ustawiony na węźle (%)
  backend text check (length(backend) <= 16),
  at timestamptz not null default now(),
  keys_total bigint not null default 0,  -- klucze z podpisanych raportów (paczki + przeliczenia), bez spornych
  chunks int not null default 0,
  first_at timestamptz not null default now()
);
alter table public.myc_p71_nodes enable row level security;

create table if not exists public.myc_p71_hits (
  id bigserial primary key,
  node_id uuid not null,
  ct text not null check (ct ~ '^[0-9a-f]+$' and length(ct) <= 4000),
  at timestamptz not null default now()
);
alter table public.myc_p71_hits enable row level security;
revoke all on public.myc_p71_chunks, public.myc_p71_nodes, public.myc_p71_hits from anon, authenticated;

create or replace function public.myc_p71_auth(p_node uuid, p_msg text, p_sig text, p_ts bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text;
begin
  select pub into k from myc_node_keys where node_id = p_node;
  if k is null then raise exception 'myc: węzeł bez klucza' using errcode = '22023'; end if;
  if abs(p_ts - (extract(epoch from now()) * 1000)::bigint) > 600000 then
    raise exception 'myc: zły czas podpisu' using errcode = '22023';
  end if;
  if not myc_wallet_verify(k, p_msg, p_sig) then raise exception 'myc: zły podpis' using errcode = '22023'; end if;
end $$;
revoke all on function public.myc_p71_auth(uuid, text, text, bigint) from public, anon, authenticated;

create or replace function public.myc_p71_out(c myc_p71_chunks, p_mode text) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('idx', c.idx, 'mode', p_mode, 'n', 4294967296)  -- start = 2^70 + idx·2^32 (liczy węzeł)
$$;
revoke all on function public.myc_p71_out(myc_p71_chunks, text) from public, anon, authenticated;

-- Przydział: otwarta paczka tego węzła (wznowienie) albo przeliczenie albo nowa losowa paczka.
create or replace function public.myc_p71_claim(p_node uuid, p_ts bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c myc_p71_chunks; i int; v bigint;
begin
  perform myc_rl('p71:' || p_node, 6);
  perform myc_p71_auth(p_node, concat_ws('|', 'MYC-P71/v1', 'claim', p_node::text, p_ts::text), p_sig, p_ts);
  select * into c from myc_p71_chunks where node_id = p_node and status = 0 limit 1;
  if found then return myc_p71_out(c, 'scan'); end if;
  select * into c from myc_p71_chunks where recheck_node = p_node and recheck_ok is null limit 1;
  if found then return myc_p71_out(c, 'recheck'); end if;
  -- porzucone przydziały (72 h bez wyniku) wracają do puli
  delete from myc_p71_chunks where status = 0 and claimed_at < now() - interval '72 hours';
  update myc_p71_chunks set recheck_node = null, recheck_claimed_at = null
    where recheck_ok is null and recheck_node is not null and recheck_claimed_at < now() - interval '72 hours';
  if random() < 0.05 then
    update myc_p71_chunks set recheck_node = p_node, recheck_claimed_at = now()
      where idx = (select idx from myc_p71_chunks where status = 1 and node_id <> p_node and recheck_node is null
                   order by random() limit 1)
      returning * into c;
    if found then return myc_p71_out(c, 'recheck'); end if;
  end if;
  if (select count(*) from myc_p71_chunks) > 200000 then
    return jsonb_build_object('error', 'limit paczek w bazie');
  end if;
  for i in 1..10 loop
    v := floor(random() * 274877906944)::bigint;
    insert into myc_p71_chunks (idx, node_id) values (v, p_node) on conflict do nothing returning * into c;
    if found then
      insert into myc_p71_nodes (node_id) values (p_node) on conflict do nothing;
      return myc_p71_out(c, 'scan');
    end if;
  end loop;
  return jsonb_build_object('error', 'brak wolnej paczki');
end $$;

-- Wynik paczki (scan) albo przeliczenia (recheck): XOR hash160 całego zakresu, liczba kluczy, czas.
create or replace function public.myc_p71_done(p_node uuid, p_idx bigint, p_mode text, p_xor text, p_keys bigint,
  p_ms bigint, p_backend text, p_ts bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c myc_p71_chunks; ok boolean;
begin
  perform myc_rl('p71:' || p_node, 6);
  perform myc_p71_auth(p_node, concat_ws('|', 'MYC-P71/v1', 'done', p_node::text, p_idx::text, p_mode, p_xor,
    p_keys::text, p_ms::text, p_backend, p_ts::text), p_sig, p_ts);
  if p_xor !~ '^[0-9a-f]{40}$' or p_keys <> 4294967296 or p_ms < 4294 or length(p_backend) > 16 then
    raise exception 'myc: zły wynik' using errcode = '22023';  -- p_ms ≥ 4294: górny limit 10^9 kluczy/s
  end if;
  if p_mode = 'scan' then
    update myc_p71_chunks set status = 1, done_at = now(), keys = p_keys, ms = p_ms, xor = p_xor, backend = p_backend
      where idx = p_idx and node_id = p_node and status = 0 returning * into c;
    if not found then return jsonb_build_object('ok', false, 'reason', 'nie twoja paczka'); end if;
    update myc_p71_nodes set keys_total = keys_total + p_keys, chunks = chunks + 1 where node_id = p_node;
    return jsonb_build_object('ok', true);
  elsif p_mode = 'recheck' then
    select * into c from myc_p71_chunks where idx = p_idx and recheck_node = p_node and recheck_ok is null for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'nie twoje przeliczenie'); end if;
    ok := c.xor = p_xor;
    update myc_p71_chunks set recheck_ok = ok, recheck_at = now(), status = case when ok then 1 else 2 end where idx = p_idx;
    insert into myc_p71_nodes (node_id) values (p_node) on conflict do nothing;
    update myc_p71_nodes set keys_total = keys_total + p_keys where node_id = p_node;
    if not ok then  -- niezgodność: paczka sporna, praca autora nie liczy się do pokrycia ani podziału
      update myc_p71_nodes set keys_total = greatest(0, keys_total - c.keys), chunks = greatest(0, chunks - 1)
        where node_id = c.node_id;
    end if;
    return jsonb_build_object('ok', true, 'match', ok);
  end if;
  raise exception 'myc: zły tryb' using errcode = '22023';
end $$;

-- Puls co ok. 5 min: bieżąca szybkość (klucze/s) i ustawiony udział mocy.
create or replace function public.myc_p71_beat(p_node uuid, p_rate bigint, p_pct int, p_backend text, p_ts bigint, p_sig text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform myc_rl('p71:' || p_node, 6);
  perform myc_p71_auth(p_node, concat_ws('|', 'MYC-P71/v1', 'beat', p_node::text, p_rate::text, p_pct::text, p_backend,
    p_ts::text), p_sig, p_ts);
  if p_rate < 0 or p_rate > 1e9 or p_pct < 0 or p_pct > 100 or length(p_backend) > 16 then
    raise exception 'myc: złe dane' using errcode = '22023';
  end if;
  insert into myc_p71_nodes (node_id, rate, pct, backend, at) values (p_node, p_rate, p_pct, p_backend, now())
    on conflict (node_id) do update set rate = excluded.rate, pct = excluded.pct, backend = excluded.backend, at = now();
  return true;
end $$;

-- Trafienie: tylko szyfrogram (do klucza publicznego właściciela). Brak odczytu publicznego, brak licznika w statystykach.
create or replace function public.myc_p71_hit(p_node uuid, p_ct text, p_ts bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform myc_rl('p71hit:' || p_node, 3);
  perform myc_p71_auth(p_node, concat_ws('|', 'MYC-P71/v1', 'hit', p_node::text, encode(sha256(convert_to(p_ct, 'UTF8')), 'hex'),
    p_ts::text), p_sig, p_ts);
  insert into myc_p71_hits (node_id, ct) values (p_node, p_ct);
  return true;
end $$;

create or replace function public.myc_p71_stats() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'keys_done', coalesce((select sum(keys) from myc_p71_chunks where status = 1), 0)::text,
    'chunks_done', (select count(*) from myc_p71_chunks where status = 1),
    'chunks_open', (select count(*) from myc_p71_chunks where status = 0),
    'chunks_disputed', (select count(*) from myc_p71_chunks where status = 2),
    'rechecks_ok', (select count(*) from myc_p71_chunks where recheck_ok),
    'rechecks_bad', (select count(*) from myc_p71_chunks where recheck_ok = false),
    'nodes_total', (select count(*) from myc_p71_nodes where keys_total > 0 or at > now() - interval '15 minutes'),
    'nodes_live', (select count(*) from myc_p71_nodes where at > now() - interval '15 minutes' and rate > 0),
    'rate_live', coalesce((select sum(rate) from myc_p71_nodes where at > now() - interval '15 minutes'), 0),
    'nodes', coalesce((select jsonb_agg(jsonb_build_object('node', left(node_id::text, 8), 'rate', rate, 'pct', pct,
        'backend', backend, 'keys', keys_total::text, 'chunks', chunks, 'live', at > now() - interval '15 minutes',
        'first_at', first_at) order by keys_total desc) from myc_p71_nodes), '[]'::jsonb),
    'first_at', (select min(first_at) from myc_p71_nodes),
    'at', now())
$$;

do $$ declare f text; begin
  foreach f in array array['myc_p71_claim(uuid, bigint, text)',
    'myc_p71_done(uuid, bigint, text, text, bigint, bigint, text, bigint, text)',
    'myc_p71_beat(uuid, bigint, int, text, bigint, text)', 'myc_p71_hit(uuid, text, bigint, text)', 'myc_p71_stats()'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
