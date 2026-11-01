-- Rozbiór zdania (warstwa rozumienia, etap A): model grzybni (tagger + parser) uczony federacyjnie przez węzły.
-- Wersja = kandydat → niezależne przeliczenie role-F1 na stałym teście UD (UD_Polish-PDB + UD_Polish-LFG, test 3942 zdań,
-- odcisk w myc_eval_sets 'rozbior') przez inny węzeł z innego IP albo zaufany weryfikator CI → publikacja.
-- Bramka: role-F1 nie niższe niż bieżące i wyższe (nie tylko równe); do publikacji trafia wynik weryfikatora, nie deklaracja.
-- To NOWA bramka obok bramki LM (2000 pytań) – bramka LM zostaje bez zmian.
-- Rundy FedAvg: węzeł trenuje od opublikowanej wersji na swoim odłamku train → aktualizacja (myc_rb_updates);
-- dowolny węzeł uśrednia aktualizacje (wagi = liczba tokenów) → kandydat.
-- Weryfikuj: typ 'parse' – rozbiór zdania z czatu do poprawy (głosy z wagą zaufania, właściciel = złota etykieta).

alter table public.myc_eval_sets drop constraint if exists myc_eval_sets_model_check;
alter table public.myc_eval_sets add constraint myc_eval_sets_model_check
  check (model in ('fashion', 'har', 'intent', 'words', 'lm', 'taxo', 'rotate', 'objects', 'ocr', 'rozbior'));
insert into public.myc_eval_sets (model, n, sha) values ('rozbior', 3942, 'a293710b41192ed977dc33cc13ad17868bb3d23b9573a2f03132bd794f849ee5')
  on conflict (model) do update set n = excluded.n, sha = excluded.sha;

create table if not exists public.myc_rb_models (
  id bigint generated always as identity primary key,
  version int,
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected', 'expired')),
  path text not null check (path ~ '^rozbior/v[0-9]{1,6}-[0-9a-f]{8}\.bin$'),
  parent int,
  f1 real check (f1 between 0 and 1),
  upos real check (upos between 0 and 1),
  feats real check (feats between 0 and 1),
  las real check (las between 0 and 1),
  metrics jsonb not null default '{}' check (pg_column_size(metrics) < 6000),
  eval_n int,
  eval_sha text,
  n_updates int not null default 0 check (n_updates between 0 and 64),
  n_tok bigint not null default 0,
  proposer uuid not null,
  proposer_ip text not null,
  verifier text,
  verify_f1 real,
  reason text check (reason is null or char_length(reason) <= 200),
  ms int,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists myc_rb_models_ver on public.myc_rb_models (version) where status = 'published';
create index if not exists myc_rb_models_status on public.myc_rb_models (status, id desc);

create table if not exists public.myc_rb_updates (
  id bigint generated always as identity primary key,
  parent int not null,
  node uuid not null,
  ip text not null,
  path text not null check (path ~ '^rozbior/u[0-9]{1,6}-[0-9a-f]{16}\.bin$'),
  shard text not null check (shard ~ '^[a-z0-9-]{1,40}$'),
  n_sent int not null check (n_sent between 1 and 100000),
  n_tok int not null check (n_tok between 1 and 5000000),
  loss real,
  ms int,
  used_in int,
  created_at timestamptz not null default now(),
  unique (parent, node)
);
alter table public.myc_rb_models enable row level security;
alter table public.myc_rb_updates enable row level security;
revoke all on public.myc_rb_models, public.myc_rb_updates from anon, authenticated;

drop policy if exists myc_rb_upload on storage.objects;
create policy myc_rb_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'myc-models' and name ~ '^rozbior/(v[0-9]{1,6}-[0-9a-f]{8}|u[0-9]{1,6}-[0-9a-f]{16})\.bin$');

create or replace function public.myc_rb_list(p_limit int default 50)
returns table (id bigint, version int, status text, path text, parent int, f1 real, upos real, feats real, las real, metrics jsonb,
               eval_n int, n_updates int, n_tok bigint, proposer uuid, verifier text, verify_f1 real, reason text, ms int,
               created_at timestamptz, decided_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, version, status, path, parent, f1, upos, feats, las, metrics, eval_n, n_updates, n_tok, proposer, verifier, verify_f1, reason, ms,
         created_at, decided_at
  from myc_rb_models order by id desc limit least(greatest(p_limit, 1), 300)
$$;
revoke all on function public.myc_rb_list(int) from public;
grant execute on function public.myc_rb_list(int) to anon, authenticated;

create or replace function public.myc_rb_updates_list(p_parent int)
returns table (id bigint, parent int, node uuid, path text, shard text, n_sent int, n_tok int, loss real, used_in int, created_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, parent, node, path, shard, n_sent, n_tok, loss, used_in, created_at from myc_rb_updates where parent = p_parent order by id limit 64
$$;
revoke all on function public.myc_rb_updates_list(int) from public;
grant execute on function public.myc_rb_updates_list(int) to anon, authenticated;

-- Aktualizacja FedAvg od opublikowanej wersji p_parent (jedna na węzeł i wersję).
create or replace function public.myc_rb_update(p_node uuid, p_parent int, p_path text, p_shard text, p_n_sent int, p_n_tok int, p_loss real, p_ms int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cur myc_rb_models; rid bigint;
begin
  perform myc_rl('rb:u:' || p_node, 12);
  select * into cur from myc_rb_models where status = 'published' order by version desc limit 1;
  if cur.id is null or p_parent is distinct from cur.version then return jsonb_build_object('ok', false, 'reason', 'stale parent', 'current', cur.version); end if;
  if p_path !~ ('^rozbior/u' || p_parent || '-[0-9a-f]{16}\.bin$') then return jsonb_build_object('ok', false, 'reason', 'bad path'); end if;
  if not exists (select 1 from storage.objects where bucket_id = 'myc-models' and name = p_path) then return jsonb_build_object('ok', false, 'reason', 'not uploaded'); end if;
  if p_loss is not null and (p_loss <> p_loss or p_loss < 0 or p_loss > 1000) then return jsonb_build_object('ok', false, 'reason', 'bad loss'); end if;
  insert into myc_rb_updates (parent, node, ip, path, shard, n_sent, n_tok, loss, ms)
  values (p_parent, p_node, myc_ip(), p_path, p_shard, p_n_sent, p_n_tok, p_loss, p_ms)
  on conflict (parent, node) do nothing returning id into rid;
  if rid is null then return jsonb_build_object('ok', false, 'reason', 'duplicate'); end if;
  return jsonb_build_object('ok', true, 'id', rid);
end $$;
revoke all on function public.myc_rb_update(uuid, int, text, text, int, int, real, int) from public;
grant execute on function public.myc_rb_update(uuid, int, text, text, int, int, real, int) to anon, authenticated;

create or replace function public.myc_rb_propose(p_node uuid, p_path text, p_parent int, p_f1 real, p_upos real, p_feats real, p_las real,
  p_metrics jsonb, p_eval_n int, p_eval_sha text, p_updates bigint[], p_ms int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cur myc_rb_models; es myc_eval_sets; nxt int; why text; rid bigint; nu int; nt bigint;
begin
  perform myc_rl('rb:p:' || p_node, 12);
  perform pg_advisory_xact_lock(hashtext('myc_rozbior'));
  update myc_rb_models set status = 'expired', decided_at = now(), reason = 'no verifier within 12 h'
   where status = 'pending' and created_at < now() - interval '12 hours';
  if exists (select 1 from myc_rb_models where status = 'pending') then return jsonb_build_object('ok', false, 'reason', 'candidate pending'); end if;
  select * into cur from myc_rb_models where status = 'published' order by version desc limit 1;
  select * into es from myc_eval_sets where model = 'rozbior';
  nxt := coalesce(cur.version, -1) + 1;
  select count(*), coalesce(sum(n_tok), 0) into nu, nt from myc_rb_updates where id = any (coalesce(p_updates, '{}')) and parent = cur.version and used_in is null;
  if p_path !~ ('^rozbior/v' || nxt || '-[0-9a-f]{8}\.bin$') then return jsonb_build_object('ok', false, 'reason', 'bad path', 'next', nxt); end if;
  if es.model is null or p_eval_n is distinct from es.n or p_eval_sha is distinct from es.sha then why := 'eval set mismatch';
  elsif cur.id is not null and p_parent is distinct from cur.version then why := 'stale parent';
  elsif cur.id is not null and nu = 0 then why := 'no updates';
  elsif cur.id is not null and p_f1 < cur.f1 then why := format('regression %s < %s', round(p_f1::numeric, 4), round(cur.f1::numeric, 4));
  elsif cur.id is not null and p_f1 = cur.f1 then why := 'not better';
  elsif not exists (select 1 from storage.objects where bucket_id = 'myc-models' and name = p_path) then
    return jsonb_build_object('ok', false, 'reason', 'not uploaded');
  end if;
  insert into myc_rb_models (version, status, path, parent, f1, upos, feats, las, metrics, eval_n, eval_sha, n_updates, n_tok, proposer, proposer_ip, reason, ms, decided_at)
  values (case when why is null then nxt end, case when why is null then 'pending' else 'rejected' end, p_path, cur.version, p_f1, p_upos, p_feats, p_las,
          coalesce(p_metrics, '{}'), p_eval_n, p_eval_sha, nu, nt, p_node, myc_ip(), why, p_ms, case when why is not null then now() end)
  returning id into rid;
  -- aktualizacje zużyte (także przy odrzuceniu – następna runda zaczyna od nowa)
  update myc_rb_updates set used_in = rid where id = any (coalesce(p_updates, '{}')) and parent = cur.version and used_in is null;
  return jsonb_build_object('ok', why is null, 'id', rid, 'reason', why, 'version', nxt, 'updates', nu);
end $$;
revoke all on function public.myc_rb_propose(uuid, text, int, real, real, real, real, jsonb, int, text, bigint[], int) from public;
grant execute on function public.myc_rb_propose(uuid, text, int, real, real, real, real, jsonb, int, text, bigint[], int) to anon, authenticated;

-- Publikacja z wynikiem weryfikatora (tolerancja 0,002 na różnice arytmetyki float32 między procesorami).
create or replace function public.myc_rb_decide(p_id bigint, p_verifier text, p_f1 real, p_metrics jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c myc_rb_models; cur myc_rb_models;
begin
  perform pg_advisory_xact_lock(hashtext('myc_rozbior'));
  select * into c from myc_rb_models where id = p_id and status = 'pending';
  if c.id is null then return jsonb_build_object('ok', false, 'reason', 'not pending'); end if;
  select * into cur from myc_rb_models where status = 'published' order by version desc limit 1;
  if p_f1 is null or abs(p_f1 - c.f1) > 0.002 then
    update myc_rb_models set status = 'rejected', verifier = p_verifier, verify_f1 = p_f1, decided_at = now(),
      reason = format('verifier mismatch %s ≠ %s', round(p_f1::numeric, 4), round(c.f1::numeric, 4)) where id = c.id;
    return jsonb_build_object('ok', false, 'reason', 'mismatch');
  end if;
  if cur.id is not null and (c.version <> cur.version + 1 or p_f1 <= cur.f1) then
    update myc_rb_models set status = 'rejected', verifier = p_verifier, verify_f1 = p_f1, decided_at = now(), reason = 'stale or not better (verified)' where id = c.id;
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  update myc_rb_models set status = 'published', verifier = p_verifier, verify_f1 = p_f1, f1 = p_f1, decided_at = now(),
    metrics = case when jsonb_typeof(p_metrics) = 'object' and pg_column_size(p_metrics) < 6000 then p_metrics else metrics end
   where id = c.id;
  return jsonb_build_object('ok', true, 'version', c.version);
end $$;
revoke all on function public.myc_rb_decide(bigint, text, real, jsonb) from public, anon, authenticated;

create or replace function public.myc_rb_verify(p_node uuid, p_id bigint, p_f1 real) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c myc_rb_models;
begin
  perform myc_rl('rb:v:' || p_node, 20);
  select * into c from myc_rb_models where id = p_id and status = 'pending';
  if c.id is null then return jsonb_build_object('ok', false, 'reason', 'not pending'); end if;
  if c.proposer = p_node or c.proposer_ip = myc_ip() then return jsonb_build_object('ok', false, 'reason', 'not independent'); end if;
  return myc_rb_decide(p_id, 'node:' || left(p_node::text, 8), p_f1, null);
end $$;
revoke all on function public.myc_rb_verify(uuid, bigint, real) from public;
grant execute on function public.myc_rb_verify(uuid, bigint, real) to anon, authenticated;

create or replace function public.myc_rb_verify_trusted(p_key text, p_id bigint, p_f1 real, p_metrics jsonb default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t myc_trusted_nodes;
begin
  perform myc_rl('trusted:' || md5(coalesce(p_key, '')), 30);
  select * into t from myc_trusted_nodes where key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if t.node is null then return jsonb_build_object('ok', false, 'reason', 'unknown key'); end if;
  return myc_rb_decide(p_id, 'trusted:' || t.label, p_f1, p_metrics);
end $$;
revoke all on function public.myc_rb_verify_trusted(text, bigint, real, jsonb) from public;
grant execute on function public.myc_rb_verify_trusted(text, bigint, real, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------- Weryfikuj: „rozbiór zdania” z czatu
create table if not exists public.myc_parses (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  sentence text not null check (char_length(sentence) between 1 and 300),
  toks jsonb not null check (jsonb_typeof(toks) = 'array' and jsonb_array_length(toks) between 1 and 60 and pg_column_size(toks) < 30000),
  model_version int,
  conf real check (conf is null or conf between 0 and 1),
  node_id uuid not null,
  contributor_id uuid,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'wrong', 'corrected')),
  posterior real not null default 0.5 check (posterior between 0 and 1),
  n_votes int not null default 0,
  decided_by text check (decided_by is null or decided_by in ('owner', 'votes')),
  decided_at timestamptz,
  correction jsonb,
  created_at timestamptz not null default now()
);
create index if not exists myc_parses_status on public.myc_parses (room, status, created_at desc);
create table if not exists public.myc_parse_votes (
  parse_id bigint not null references public.myc_parses (id) on delete cascade,
  voter_node uuid not null,
  contributor_id uuid,
  vote text not null check (vote in ('confirm', 'disagree', 'correct')),
  correction jsonb check (correction is null or (jsonb_typeof(correction) = 'array' and jsonb_array_length(correction) between 1 and 60 and pg_column_size(correction) < 8000)),
  voter text not null check (voter in ('owner', 'person', 'agent')),
  acc real not null check (acc between 0.5 and 1),
  created_at timestamptz not null default now(),
  primary key (parse_id, voter_node)
);
alter table public.myc_parses enable row level security;
alter table public.myc_parse_votes enable row level security;
revoke all on public.myc_parses, public.myc_parse_votes from anon, authenticated;
grant select (id, room, sentence, toks, model_version, conf, status, posterior, n_votes, decided_by, decided_at, correction, created_at)
  on public.myc_parses to anon, authenticated;
drop policy if exists myc_parses_read on public.myc_parses;
create policy myc_parses_read on public.myc_parses for select to anon, authenticated using (true);

-- tokeny: tylko {form, lemma, upos, head, deprel, part, q, of, p}; zdanie czyszczone z danych osobowych (myc_scrub)
create or replace function public.myc_parse_log(p_node uuid, p_contrib uuid, p_sentence text, p_toks jsonb, p_version int, p_conf real, p_room text default 'main')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid; s text := left(myc_scrub(p_sentence), 300); t jsonb := '[]'::jsonb; e jsonb; id_ bigint;
begin
  if p_node is null then raise exception 'myc: node' using errcode = '22023'; end if;
  if p_room not in ('main', 'e2e') then raise exception 'myc: room' using errcode = '22023'; end if;
  perform myc_rl('plog:' || p_node, 20);
  if auth.uid() is not null then
    select account_id into acc from myc_account_devices where user_id = auth.uid();
    if acc is not null and exists (select 1 from myc_account_prefs where account_id = acc and not train_ok) then
      return jsonb_build_object('logged', false, 'reason', 'optout');
    end if;
  end if;
  if char_length(s) < 1 or s ~ '\[(e-mail|link|telefon|pseudonim|imię)\]' then return jsonb_build_object('logged', false, 'reason', 'personal'); end if;
  if jsonb_typeof(p_toks) <> 'array' or jsonb_array_length(p_toks) not between 1 and 60 then raise exception 'myc: tokeny' using errcode = '22023'; end if;
  for e in select * from jsonb_array_elements(p_toks) loop
    t := t || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'form', left(coalesce(e ->> 'form', ''), 40), 'lemma', left(e ->> 'lemma', 40),
      'upos', case when (e ->> 'upos') ~ '^[A-Z]{1,5}$' then e ->> 'upos' end,
      'head', case when (e ->> 'head') ~ '^\d{1,2}$' then (e ->> 'head')::int end,
      'deprel', case when (e ->> 'deprel') ~ '^[a-z:]{1,20}$' then e ->> 'deprel' end,
      'part', left(e ->> 'part', 20), 'q', left(e ->> 'q', 30),
      'of', case when (e ->> 'of') ~ '^\d{1,2}$' then (e ->> 'of')::int end,
      'p', case when (e ->> 'p') ~ '^(0(\.\d+)?|1(\.0+)?)$' then (e ->> 'p')::real end)));
  end loop;
  insert into myc_parses (room, sentence, toks, model_version, conf, node_id, contributor_id)
  values (p_room, s, t, p_version, case when p_conf between 0 and 1 then p_conf end, p_node, p_contrib)
  returning id into id_;
  return jsonb_build_object('logged', true, 'id', id_);
end $$;
revoke all on function public.myc_parse_log(uuid, uuid, text, jsonb, int, real, text) from public;
grant execute on function public.myc_parse_log(uuid, uuid, text, jsonb, int, real, text) to anon, authenticated;

-- Głos: confirm / disagree / correct (correction = [{i, part?, q?, upos?, head?}]); wagi jak przy odpowiedziach czatu.
create or replace function public.myc_parse_vote(p_key text, p_node uuid, p_contrib uuid, p_id bigint, p_vote text, p_correction jsonb default null, p_agent boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m myc_parses; kroom text := myc_key_room(p_key); who text; a real; n int; c int; lg double precision; post real; nv int; dec text;
  best jsonb; best_w double precision; corr jsonb := '[]'::jsonb; e jsonb;
begin
  if p_node is null or p_vote not in ('confirm', 'disagree', 'correct') then raise exception 'myc: głos' using errcode = '22023'; end if;
  perform myc_rl('pvote:' || p_node, 120);
  select * into m from myc_parses where id = p_id for update;
  if m.id is null then raise exception 'myc: brak rozbioru' using errcode = '22023'; end if;
  if p_vote = 'correct' then
    if jsonb_typeof(p_correction) <> 'array' then raise exception 'myc: brak poprawki' using errcode = '22023'; end if;
    for e in select * from jsonb_array_elements(p_correction) limit 60 loop
      continue when not ((e ->> 'i') ~ '^\d{1,2}$') or (e ->> 'i')::int not between 1 and jsonb_array_length(m.toks);
      corr := corr || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('i', (e ->> 'i')::int,
        'part', case when e ->> 'part' in ('podmiot', 'orzeczenie', 'orzecznik', 'łącznik', 'dopełnienie', 'przydawka', 'okolicznik', 'spójnik', 'przyimek', 'partykuła', 'przeczenie', 'wołacz', 'wykrzyknik', 'interpunkcja', 'inne') then e ->> 'part' end,
        'q', left(e ->> 'q', 30),
        'upos', case when (e ->> 'upos') ~ '^(NOUN|PROPN|VERB|AUX|ADJ|ADV|PRON|DET|NUM|ADP|CCONJ|SCONJ|PART|INTJ|PUNCT|SYM|X)$' then e ->> 'upos' end,
        'head', case when (e ->> 'head') ~ '^\d{1,2}$' and (e ->> 'head')::int <= jsonb_array_length(m.toks) then (e ->> 'head')::int end)));
    end loop;
    if jsonb_array_length(corr) = 0 then raise exception 'myc: pusta poprawka' using errcode = '22023'; end if;
  end if;
  if m.status <> 'pending' and kroom is null then return jsonb_build_object('ok', false, 'reason', 'decided', 'status', m.status); end if;
  if m.node_id = p_node and kroom is null then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
  if kroom is not null then
    if kroom <> m.room then raise exception 'myc: klucz z innego pokoju' using errcode = '42501'; end if;
    who := 'owner'; a := 0.99;
  else
    select s.n, s.correct into n, c from myc_gold_stats() s where s.node_id = p_node;
    a := least(greatest((coalesce(c, 0) + 3)::real / (coalesce(n, 0) + 4), 0.55), case when p_agent then 0.7 else 0.9 end);
    who := case when p_agent then 'agent' else 'person' end;
  end if;
  insert into myc_parse_votes (parse_id, voter_node, contributor_id, vote, correction, voter, acc)
  values (m.id, p_node, p_contrib, p_vote, case when p_vote = 'correct' then corr end, who, a)
  on conflict (parse_id, voter_node) do update set vote = excluded.vote, correction = excluded.correction, acc = excluded.acc, voter = excluded.voter, created_at = now();
  select coalesce(sum(case when vote = 'confirm' then 1 else -1 end * ln(acc / (1 - acc))), 0), count(*)
    into lg, nv from myc_parse_votes where parse_id = m.id and voter <> 'owner';
  post := (1 / (1 + exp(-lg)))::real;
  dec := null;
  if who = 'owner' then dec := case when p_vote = 'confirm' then 'confirmed' else 'wrong' end;
  elsif nv >= 3 and post >= 0.95 then dec := 'confirmed';
  elsif nv >= 3 and post <= 0.05 then dec := 'wrong';
  end if;
  if dec = 'wrong' then
    if who = 'owner' and p_vote = 'correct' then best := corr; best_w := 99;
    else
      select v.correction, sum(ln(v.acc / (1 - v.acc))) into best, best_w from myc_parse_votes v
       where v.parse_id = m.id and v.vote = 'correct' and v.voter <> 'owner' group by v.correction order by 2 desc limit 1;
    end if;
    if best is not null and best_w >= ln(0.9 / 0.1) then dec := 'corrected'; end if;
  end if;
  update myc_parses set posterior = case when who = 'owner' then (case when p_vote = 'confirm' then 1 else 0 end) else post end,
         n_votes = nv + (case when who = 'owner' then 1 else 0 end), status = coalesce(dec, status),
         decided_by = case when dec is not null then (case when who = 'owner' then 'owner' else 'votes' end) else decided_by end,
         decided_at = case when dec is not null then now() else decided_at end,
         correction = case when dec = 'corrected' then best else correction end
   where id = m.id returning * into m;
  return jsonb_build_object('ok', true, 'voter', who, 'acc', a, 'posterior', m.posterior, 'status', m.status, 'votes', m.n_votes);
end $$;
revoke all on function public.myc_parse_vote(text, uuid, uuid, bigint, text, jsonb, boolean) from public;
grant execute on function public.myc_parse_vote(text, uuid, uuid, bigint, text, jsonb, boolean) to anon, authenticated;

-- Rozbiory zatwierdzone przez ludzi (potwierdzone albo poprawione) → dane do treningu węzłów (słabe etykiety).
create or replace function public.myc_parse_train(p_limit int default 2000)
returns table (id bigint, sentence text, toks jsonb, status text, correction jsonb, decided_by text, decided_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, sentence, toks, status, correction, decided_by, decided_at from myc_parses
  where room = 'main' and status in ('confirmed', 'corrected') order by id desc limit least(greatest(p_limit, 1), 5000)
$$;
revoke all on function public.myc_parse_train(int) from public;
grant execute on function public.myc_parse_train(int) to anon, authenticated;

create or replace function public.myc_parses_e2e_cleanup(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if myc_key_room(p_key) is distinct from 'e2e' then raise exception 'myc: klucz' using errcode = '42501'; end if;
  delete from myc_parses where room = 'e2e';
  get diagnostics n = row_count;
  return jsonb_build_object('deleted', n);
end $$;
revoke all on function public.myc_parses_e2e_cleanup(text) from public;
grant execute on function public.myc_parses_e2e_cleanup(text) to anon, authenticated;
