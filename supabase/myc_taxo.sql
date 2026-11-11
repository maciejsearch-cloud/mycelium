-- Samoorganizująca się taksonomia słów (węzły grupują słowa same; src/iot_mycelium/mesh/taxo.py).
-- Wersja = kandydat od węzła → niezależne przeliczenie metryk z opublikowanego przypisania (inny węzeł z innego IP
-- albo zaufany weryfikator CI) → publikacja. Bramka: stały zbiór oceny (odcisk sha256) i trafność nie niższa niż
-- bieżąca (tolerancja 0); bez nowych poprawek właściciela wersja musi być lepsza, nie tylko równa.

alter table public.myc_eval_sets drop constraint if exists myc_eval_sets_model_check;
alter table public.myc_eval_sets add constraint myc_eval_sets_model_check
  check (model in ('fashion', 'har', 'intent', 'words', 'lm', 'taxo', 'rotate', 'objects', 'ocr'));
insert into public.myc_eval_sets (model, n, sha) values ('taxo', 2174, 'd008afe6316d3e7b27d051fb3811f2842f05a4abf0bccddcbe4030a0467ad854')
  on conflict (model) do nothing;

create table if not exists public.myc_taxonomy (
  id bigint generated always as identity primary key,
  version int,
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected', 'expired')),
  path text check (path is null or path ~ '^taxo/v[0-9]{1,6}-[0-9a-f]{8}\.json$'),
  acc real check (acc between 0 and 1),
  nmi real check (nmi between 0 and 1),
  purity real check (purity between 0 and 1),
  metrics jsonb not null default '{}' check (pg_column_size(metrics) < 4000),
  params jsonb not null default '{}' check (pg_column_size(params) < 1000),
  eval_n int,
  eval_sha text,
  inputs_sha text check (inputs_sha is null or inputs_sha ~ '^[0-9a-f]{64}$'),
  n_corr int not null default 0 check (n_corr >= 0),
  proposer uuid not null,
  proposer_ip text not null,
  verifier text,
  verify_acc real,
  reason text check (reason is null or char_length(reason) <= 200),
  ms int,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists myc_taxonomy_ver on public.myc_taxonomy (version) where status = 'published';
create index if not exists myc_taxonomy_status on public.myc_taxonomy (status, id desc);
alter table public.myc_taxonomy enable row level security;
revoke all on public.myc_taxonomy from anon, authenticated;

-- Publiczny podgląd (bez skrótów IP).
create or replace function public.myc_tax_list(p_limit int default 200)
returns table (id bigint, version int, status text, path text, acc real, nmi real, purity real, metrics jsonb, params jsonb,
               n_corr int, proposer uuid, verifier text, verify_acc real, reason text, ms int, created_at timestamptz, decided_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, version, status, path, acc, nmi, purity, metrics, params, n_corr, proposer, verifier, verify_acc, reason, ms, created_at, decided_at
  from myc_taxonomy order by id desc limit least(greatest(p_limit, 1), 500)
$$;
revoke all on function public.myc_tax_list(int) from public;
grant execute on function public.myc_tax_list(int) to anon, authenticated;

drop policy if exists myc_taxo_upload on storage.objects;
create policy myc_taxo_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'myc-models' and name ~ '^taxo/v[0-9]{1,6}-[0-9a-f]{8}\.json$');

create or replace function public.myc_tax_propose(p_node uuid, p_path text, p_acc real, p_nmi real, p_purity real, p_metrics jsonb,
  p_params jsonb, p_eval_n int, p_eval_sha text, p_inputs_sha text, p_n_corr int, p_ms int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cur myc_taxonomy; es myc_eval_sets; nxt int; why text; rid bigint;
begin
  perform myc_rl('taxo:p:' || p_node, 12);
  perform pg_advisory_xact_lock(hashtext('myc_taxo'));
  update myc_taxonomy set status = 'expired', decided_at = now(), reason = 'no verifier within 12 h'
   where status = 'pending' and created_at < now() - interval '12 hours';
  if exists (select 1 from myc_taxonomy where status = 'pending') then return jsonb_build_object('ok', false, 'reason', 'candidate pending'); end if;
  select * into cur from myc_taxonomy where status = 'published' order by version desc limit 1;
  select * into es from myc_eval_sets where model = 'taxo';
  nxt := coalesce(cur.version, -1) + 1;
  if p_path !~ ('^taxo/v' || nxt || '-[0-9a-f]{8}\.json$') then return jsonb_build_object('ok', false, 'reason', 'bad path', 'next', nxt); end if;
  if not exists (select 1 from storage.objects where bucket_id = 'myc-models' and name = p_path) then return jsonb_build_object('ok', false, 'reason', 'not uploaded'); end if;
  if es.model is null or p_eval_n is distinct from es.n or p_eval_sha is distinct from es.sha then why := 'eval set mismatch';
  elsif cur.id is not null and p_acc < cur.acc then why := format('regression %s < %s', round(p_acc::numeric, 4), round(cur.acc::numeric, 4));
  elsif cur.id is not null and p_acc = cur.acc and coalesce(p_n_corr, 0) <= cur.n_corr then why := 'not better';
  end if;
  insert into myc_taxonomy (version, status, path, acc, nmi, purity, metrics, params, eval_n, eval_sha, inputs_sha, n_corr, proposer, proposer_ip, reason, ms, decided_at)
  values (case when why is null then nxt end, case when why is null then 'pending' else 'rejected' end, p_path, p_acc, p_nmi, p_purity,
          coalesce(p_metrics, '{}'), coalesce(p_params, '{}'), p_eval_n, p_eval_sha, p_inputs_sha, coalesce(p_n_corr, 0), p_node, myc_ip(), why, p_ms,
          case when why is not null then now() end)
  returning id into rid;
  return jsonb_build_object('ok', why is null, 'id', rid, 'reason', why, 'version', nxt);
end $$;
revoke all on function public.myc_tax_propose(uuid, text, real, real, real, jsonb, jsonb, int, text, text, int, int) from public;
grant execute on function public.myc_tax_propose(uuid, text, real, real, real, jsonb, jsonb, int, text, text, int, int) to anon, authenticated;

create or replace function public.myc_tax_decide(p_id bigint, p_verifier text, p_acc real) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c myc_taxonomy; cur myc_taxonomy;
begin
  perform pg_advisory_xact_lock(hashtext('myc_taxo'));
  select * into c from myc_taxonomy where id = p_id and status = 'pending';
  if c.id is null then return jsonb_build_object('ok', false, 'reason', 'not pending'); end if;
  select * into cur from myc_taxonomy where status = 'published' order by version desc limit 1;
  if abs(p_acc - c.acc) > 1e-5 then
    update myc_taxonomy set status = 'rejected', verifier = p_verifier, verify_acc = p_acc, decided_at = now(),
      reason = format('verifier mismatch %s ≠ %s', round(p_acc::numeric, 5), round(c.acc::numeric, 5)) where id = c.id;
    return jsonb_build_object('ok', false, 'reason', 'mismatch');
  end if;
  if cur.id is not null and (c.version <> cur.version + 1 or c.acc < cur.acc) then
    update myc_taxonomy set status = 'rejected', verifier = p_verifier, verify_acc = p_acc, decided_at = now(), reason = 'stale' where id = c.id;
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  update myc_taxonomy set status = 'published', verifier = p_verifier, verify_acc = p_acc, decided_at = now() where id = c.id;
  return jsonb_build_object('ok', true, 'version', c.version);
end $$;
revoke all on function public.myc_tax_decide(bigint, text, real) from public, anon, authenticated;

-- Niezależny węzeł (inny niż zgłaszający, z innego IP) przelicza metryki z opublikowanego przypisania.
create or replace function public.myc_tax_verify(p_node uuid, p_id bigint, p_acc real) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c myc_taxonomy;
begin
  perform myc_rl('taxo:v:' || p_node, 20);
  select * into c from myc_taxonomy where id = p_id and status = 'pending';
  if c.id is null then return jsonb_build_object('ok', false, 'reason', 'not pending'); end if;
  if c.proposer = p_node or c.proposer_ip = myc_ip() then return jsonb_build_object('ok', false, 'reason', 'not independent'); end if;
  return myc_tax_decide(p_id, 'node:' || left(p_node::text, 8), p_acc);
end $$;
revoke all on function public.myc_tax_verify(uuid, bigint, real) from public;
grant execute on function public.myc_tax_verify(uuid, bigint, real) to anon, authenticated;

create or replace function public.myc_tax_verify_trusted(p_key text, p_id bigint, p_acc real) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t myc_trusted_nodes;
begin
  perform myc_rl('trusted:' || md5(coalesce(p_key, '')), 30);
  select * into t from myc_trusted_nodes where key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if t.node is null then return jsonb_build_object('ok', false, 'reason', 'unknown key'); end if;
  return myc_tax_decide(p_id, 'trusted:' || t.label, p_acc);
end $$;
revoke all on function public.myc_tax_verify_trusted(text, bigint, real) from public;
grant execute on function public.myc_tax_verify_trusted(text, bigint, real) to anon, authenticated;

-- Weryfikuj: nowe rodzaje pozycji (kategoria z taksonomii, obraz, odczyt tekstu OCR).
alter table public.myc_reviews drop constraint if exists myc_reviews_item_type_check;
alter table public.myc_reviews add constraint myc_reviews_item_type_check
  check (item_type in ('answer', 'word', 'captcha', 'teach', 'chat', 'fragment', 'model', 'category', 'image', 'ocr'));

-- Strzępki z taksonomii (pojęcia = kategorie, tematy = grupy kategorii); zaufanie z pokrycia hiperonimem (≤ 0,7).
alter table public.myc_frags drop constraint if exists myc_frags_source_check;
alter table public.myc_frags add constraint myc_frags_source_check
  check (source in ('wikidata', 'plwordnet', 'wordnet', 'wiktionary', 'consensus', 'teach', 'captcha', 'owner', 'chat', 'link', 'taxonomy', 'vision'));
create or replace function public.myc_frag_trust(p_source text, p_hint real) returns real
language sql immutable as $$
  select case p_source
    when 'wikidata' then 0.9 when 'plwordnet' then 0.85 when 'wordnet' then 0.85 when 'wiktionary' then 0.8
    when 'consensus' then least(greatest(coalesce(p_hint, 0.5), 0), 0.8)
    when 'teach' then 0.5 when 'captcha' then least(greatest(coalesce(p_hint, 0.5), 0), 0.7)
    when 'chat' then 0.4 when 'link' then least(greatest(coalesce(p_hint, 0.5), 0), 0.85)
    when 'taxonomy' then least(greatest(coalesce(p_hint, 0.5), 0), 0.7)
    when 'vision' then least(greatest(coalesce(p_hint, 0.5), 0), 0.7)
    else 0.3 end::real
$$;
