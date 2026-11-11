-- Odpowiedzi czatu w Weryfikuj (typ 'answer'): każda odpowiedź czatu trafia na żywo do przeglądu.
-- Wiersz: pytanie (bez pseudonimów, e-maili, linków, telefonów – czyszczone w przeglądarce i ponownie tutaj), odpowiedź,
-- użyte źródła, pewność, etykiety (temat/kategoria z taksonomii, intencja, czy ma źródło, rejestr).
-- Głosy: potwierdź / nie zgadzam się / popraw (poprawiona odpowiedź + opcjonalne źródło). Waga głosu = trafność głosującego
-- na złotych etykietach (Dawid–Skene jak w myc_meanings), klucz właściciela = złota etykieta, ludzie maks. 0,9, agenci 0,7.
-- Rozstrzygnięcie: zatwierdzona poprawka → strzępek 'odpowiedz' (pamięć wiedzy czatu, z pochodzeniem answer:<id>);
-- odpowiedź uznana za błędną → zestaw regresji „nigdy więcej” (myc_error_set) – OSOBNY od zestawu 2000 pytań bramki LM.
-- Zapis wyłącznie przez RPC (limiter); anon nie może zapisać stanu rozstrzygnięcia. Rezygnacja z nauki na koncie
-- (myc_account_prefs.train_ok = false) → odpowiedź nie jest zapisywana.

create table if not exists public.myc_chat_answers (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  question text not null check (char_length(question) between 1 and 400),
  answer text not null check (char_length(answer) between 1 and 2000),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) <= 8),
  conf real check (conf is null or conf between 0 and 1),
  topic text check (topic is null or char_length(topic) <= 80),
  category text check (category is null or char_length(category) <= 120),
  intent text not null default 'pytanie' check (intent in ('pytanie', 'emocja', 'niezgoda', 'nauka', 'rozmowa', 'polecenie')),
  has_source boolean not null default false,
  register text not null default 'neutralne' check (register in ('neutralne', 'potoczne', 'wulgarne', 'obraźliwe', 'slang', 'ironiczne')),
  act text check (act is null or act ~ '^[a-z_]{2,24}$'),
  mode text not null default 'lite' check (mode in ('lite', 'mesh', 'local')),
  node_id uuid not null,
  contributor_id uuid,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'wrong', 'corrected')),
  posterior real not null default 0.5 check (posterior between 0 and 1),
  n_votes int not null default 0,
  n_confirm int not null default 0,
  n_corrections int not null default 0,
  decided_by text check (decided_by is null or decided_by in ('owner', 'votes')),
  decided_at timestamptz,
  correction text,
  correction_source text,
  frag_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists myc_chat_answers_status on public.myc_chat_answers (room, status, created_at desc);
create index if not exists myc_chat_answers_labels on public.myc_chat_answers (room, intent, has_source, topic);

create table if not exists public.myc_chat_answer_votes (
  answer_id bigint not null references public.myc_chat_answers (id) on delete cascade,
  voter_node uuid not null,
  contributor_id uuid,
  vote text not null check (vote in ('confirm', 'disagree', 'correct')),
  correction text check (correction is null or char_length(correction) between 1 and 600),
  correction_source text check (correction_source is null or char_length(correction_source) <= 300),
  voter text not null check (voter in ('owner', 'person', 'agent')),
  acc real not null check (acc between 0.5 and 1),
  created_at timestamptz not null default now(),
  primary key (answer_id, voter_node)
);

-- „Nigdy więcej”: pytania, na które czat odpowiedział źle (zestaw regresji czatu; nie jest zestawem bramki LM).
create table if not exists public.myc_error_set (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  answer_id bigint not null unique references public.myc_chat_answers (id) on delete cascade,
  question text not null,
  wrong_answer text not null,
  correct_answer text,
  correct_source text,
  decided_by text not null,
  added_at timestamptz not null default now()
);

alter table public.myc_chat_answers enable row level security;
alter table public.myc_chat_answer_votes enable row level security;
alter table public.myc_error_set enable row level security;
revoke all on public.myc_chat_answers, public.myc_chat_answer_votes, public.myc_error_set from anon, authenticated;
-- odczyt publiczny bez identyfikatorów węzła/kontrybutora
grant select (id, room, question, answer, sources, conf, topic, category, intent, has_source, register, act, mode, status, posterior,
  n_votes, n_confirm, n_corrections, decided_by, decided_at, correction, correction_source, frag_id, created_at) on public.myc_chat_answers to anon, authenticated;
grant select on public.myc_error_set to anon, authenticated;
drop policy if exists myc_chat_answers_read on public.myc_chat_answers;
create policy myc_chat_answers_read on public.myc_chat_answers for select to anon, authenticated using (true);
drop policy if exists myc_error_set_read on public.myc_error_set;
create policy myc_error_set_read on public.myc_error_set for select to anon, authenticated using (true);

-- Usuwa dane osobowe z tekstu: e-maile, linki, telefony, @pseudonimy, „mam na imię X / nazywam się X”.
create or replace function public.myc_scrub(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
    '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}', '[e-mail]', 'g'),
    '(https?://|www\.)[^[:space:]]+', '[link]', 'gi'),
    '\+?[0-9][0-9 ().-]{7,}[0-9]', '[telefon]', 'g'),
    '(^|[[:space:]])@[[:alnum:]_.]{2,}', '\1[pseudonim]', 'g'),
    '((mam na imi[eę]|nazywam si[eę]|my name is|call me|m[oó]w mi)[[:space:]]+)[[:alpha:]ąćęłńóśźżĄĆĘŁŃÓŚŹŻ-]{2,}', '\1[imię]', 'gi'),
    '[[:space:]]+', ' ', 'g'))
$$;

create or replace function public.myc_answer_log(p_node uuid, p_contrib uuid, p_question text, p_answer text, p_sources jsonb,
  p_conf real, p_topic text, p_category text, p_intent text, p_register text, p_act text, p_mode text, p_room text default 'main')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid; q text := left(myc_scrub(p_question), 400); a text := left(btrim(coalesce(p_answer, '')), 2000); src jsonb := '[]'::jsonb; id_ bigint; e jsonb;
begin
  if p_node is null then raise exception 'myc: node' using errcode = '22023'; end if;
  if p_room not in ('main', 'e2e') then raise exception 'myc: room' using errcode = '22023'; end if;
  perform myc_rl('alog:' || p_node, 20);
  -- rezygnacja z nauki na koncie (jeśli zalogowany)
  if auth.uid() is not null then
    select account_id into acc from myc_account_devices where user_id = auth.uid();
    if acc is not null and exists (select 1 from myc_account_prefs where account_id = acc and not train_ok) then
      return jsonb_build_object('logged', false, 'reason', 'optout');
    end if;
  end if;
  if char_length(q) < 1 or char_length(a) < 1 then raise exception 'myc: długość' using errcode = '22023'; end if;
  -- źródła: tylko {kind, title, url?}, maks. 8, linki tylko https
  if jsonb_typeof(p_sources) = 'array' then
    for e in select * from jsonb_array_elements(p_sources) limit 8 loop
      continue when coalesce(btrim(e ->> 'title'), '') = '';
      src := src || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'kind', left(coalesce(e ->> 'kind', 'inne'), 24),
        'title', left(coalesce(e ->> 'title', ''), 200),
        'url', case when (e ->> 'url') ~ '^https://[a-z0-9.-]+\.(wikipedia|wiktionary|wikidata)\.org/' then left(e ->> 'url', 300) end,
        'votes', case when (e ->> 'votes') ~ '^\d{1,6}$' then (e ->> 'votes')::int end)));
    end loop;
  end if;
  insert into myc_chat_answers (room, question, answer, sources, conf, topic, category, intent, has_source, register, act, mode, node_id, contributor_id)
  values (p_room, q, a, src, case when p_conf between 0 and 1 then p_conf end, left(nullif(btrim(p_topic), ''), 80), left(nullif(btrim(p_category), ''), 120),
    case when p_intent in ('pytanie', 'emocja', 'niezgoda', 'nauka', 'rozmowa', 'polecenie') then p_intent else 'pytanie' end,
    jsonb_array_length(src) > 0,
    case when p_register in ('neutralne', 'potoczne', 'wulgarne', 'obraźliwe', 'slang', 'ironiczne') then p_register else 'neutralne' end,
    case when p_act ~ '^[a-z_]{2,24}$' then p_act end, case when p_mode in ('mesh', 'local') then p_mode else 'lite' end, p_node, p_contrib)
  returning id into id_;
  return jsonb_build_object('logged', true, 'id', id_);
end $$;
revoke all on function public.myc_answer_log(uuid, uuid, text, text, jsonb, real, text, text, text, text, text, text, text) from public;
grant execute on function public.myc_answer_log(uuid, uuid, text, text, jsonb, real, text, text, text, text, text, text, text) to anon, authenticated;

-- Głos: confirm / disagree / correct (correct liczy się jak „nie zgadzam się” + propozycja poprawnej odpowiedzi).
create or replace function public.myc_answer_vote(p_key text, p_node uuid, p_contrib uuid, p_id bigint, p_vote text,
  p_correction text default null, p_source text default null, p_agent boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m myc_chat_answers; kroom text := myc_key_room(p_key); who text; a real; n int; c int; lg double precision; post real; nv int; nc int; ncor int;
  dec text; best text; best_src text; best_w double precision; fid bigint; corr text := left(nullif(btrim(regexp_replace(coalesce(p_correction, ''), '\s+', ' ', 'g')), ''), 600);
  srcx text := left(nullif(btrim(coalesce(p_source, '')), ''), 300);
begin
  if p_node is null or p_vote not in ('confirm', 'disagree', 'correct') then raise exception 'myc: głos' using errcode = '22023'; end if;
  if p_vote = 'correct' and corr is null then raise exception 'myc: brak poprawki' using errcode = '22023'; end if;
  perform myc_rl('avote:' || p_node, 120);
  select * into m from myc_chat_answers where id = p_id for update;
  if m.id is null then raise exception 'myc: brak odpowiedzi' using errcode = '22023'; end if;
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
  insert into myc_chat_answer_votes (answer_id, voter_node, contributor_id, vote, correction, correction_source, voter, acc)
  values (m.id, p_node, p_contrib, p_vote, case when p_vote = 'correct' then corr end, case when p_vote = 'correct' then srcx end, who, a)
  on conflict (answer_id, voter_node) do update set vote = excluded.vote, correction = excluded.correction, correction_source = excluded.correction_source,
    acc = excluded.acc, voter = excluded.voter, created_at = now();
  select coalesce(sum(case when vote = 'confirm' then 1 else -1 end * ln(acc / (1 - acc))), 0), count(*), count(*) filter (where vote = 'confirm'),
         count(*) filter (where vote = 'correct')
    into lg, nv, nc, ncor from myc_chat_answer_votes where answer_id = m.id and voter <> 'owner';
  post := (1 / (1 + exp(-lg)))::real;
  dec := null;
  if who = 'owner' then dec := case when p_vote = 'confirm' then 'confirmed' else 'wrong' end;
  elsif nv >= 3 and post >= 0.95 then dec := 'confirmed';
  elsif nv >= 3 and post <= 0.05 then dec := 'wrong';
  end if;
  -- najlepsza poprawka: właściciela, inaczej ta z największą sumą wag (log-odds) – zatwierdzona, gdy suma ≥ ln(0,9/0,1)
  if dec = 'wrong' then
    if who = 'owner' and p_vote = 'correct' then best := corr; best_src := srcx; best_w := 99;
    else
      select max(v.correction), max(v.correction_source), sum(ln(v.acc / (1 - v.acc))) into best, best_src, best_w
        from myc_chat_answer_votes v where v.answer_id = m.id and v.vote = 'correct' and v.voter <> 'owner'
       group by lower(v.correction) order by 3 desc limit 1;
    end if;
    if best is not null and best_w >= ln(0.9 / 0.1) then
      dec := 'corrected';
      insert into myc_frags (room, layer, key, subj, rel, obj, lang, source, source_ref, trust, status, node_id)
      values (m.room, 0, myc_frag_key(0, left(m.question, 160), 'odpowiedz', left(best, 300)), left(m.question, 160), 'odpowiedz', left(best, 300), 'pl',
              case when who = 'owner' then 'owner' else 'consensus' end, left('answer:' || m.id || coalesce(' ' || best_src, ''), 200),
              case when who = 'owner' then 1 else 0.9 end, 'verified', p_node)
      on conflict (room, key) do update set status = 'verified', trust = greatest(myc_frags.trust, excluded.trust), updated_at = now()
      returning id into fid;
    end if;
    insert into myc_error_set (room, answer_id, question, wrong_answer, correct_answer, correct_source, decided_by)
    values (m.room, m.id, m.question, m.answer, case when dec = 'corrected' then best end, case when dec = 'corrected' then best_src end, case when who = 'owner' then 'owner' else 'votes' end)
    on conflict (answer_id) do update set correct_answer = excluded.correct_answer, correct_source = excluded.correct_source;
  elsif dec = 'confirmed' then
    delete from myc_error_set where answer_id = m.id;
  end if;
  update myc_chat_answers set posterior = case when who = 'owner' then (case when p_vote = 'confirm' then 1 else 0 end) else post end,
         n_votes = nv + (case when who = 'owner' then 1 else 0 end), n_confirm = nc + (case when who = 'owner' and p_vote = 'confirm' then 1 else 0 end),
         n_corrections = ncor + (case when who = 'owner' and p_vote = 'correct' then 1 else 0 end),
         status = coalesce(dec, status), decided_by = case when dec is not null then (case when who = 'owner' then 'owner' else 'votes' end) else decided_by end,
         decided_at = case when dec is not null then now() else decided_at end,
         correction = case when dec = 'corrected' then best else correction end, correction_source = case when dec = 'corrected' then best_src else correction_source end,
         frag_id = coalesce(fid, frag_id)
   where id = m.id returning * into m;
  return jsonb_build_object('ok', true, 'voter', who, 'acc', a, 'posterior', m.posterior, 'status', m.status, 'votes', m.n_votes, 'frag', m.frag_id);
end $$;
revoke all on function public.myc_answer_vote(text, uuid, uuid, bigint, text, text, text, boolean) from public;
grant execute on function public.myc_answer_vote(text, uuid, uuid, bigint, text, text, text, boolean) to anon, authenticated;

-- Pokój testów: sprzątanie odpowiedzi (klucz testowy e2e)
create or replace function public.myc_answers_e2e_cleanup(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if myc_key_room(p_key) is distinct from 'e2e' then raise exception 'myc: klucz' using errcode = '42501'; end if;
  delete from myc_frags where room = 'e2e' and rel = 'odpowiedz' and source_ref like 'answer:%';
  delete from myc_chat_answers where room = 'e2e';
  get diagnostics n = row_count;
  return jsonb_build_object('answers', n);
end $$;
revoke all on function public.myc_answers_e2e_cleanup(text) from public;
grant execute on function public.myc_answers_e2e_cleanup(text) to anon, authenticated;
