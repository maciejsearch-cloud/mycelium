-- Nauka z czatu: znaczenia słów i zwrotów (także slang i wulgaryzmy) wyjaśnione przez ludzi.
-- Czat nie zna słowa → prosi o wyjaśnienie → wiersz 'pending' (słowo, znaczenie, rejestr, przykład, autor, rozmowa).
-- Głosują ludzie i agenci węzłów: „prawda” / „kłamstwo”. Waga głosu = trafność głosującego na złotych etykietach
-- (jednomonetowy model Dawida–Skene'a: logit += ±ln(acc / (1 − acc))); głos właścicielki = złota etykieta i rozstrzyga.
-- Dopiero zatwierdzone znaczenie staje się strzępkiem (myc_frags), trafia do danych treningu LM i jest używane w czacie.
-- room: 'main' = prawdziwa grzybnia, 'e2e' = pokój testów (sprzątany przez myc_e2e_cleanup).

create table if not exists public.myc_meanings (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  word text not null check (char_length(word) between 1 and 60),
  meaning text not null check (char_length(meaning) between 2 and 300),
  register text not null default 'neutralne' check (register in ('neutralne', 'potoczne', 'wulgarne', 'obraźliwe', 'slang', 'ironiczne')),
  example text check (example is null or char_length(example) <= 300),
  lang text not null default 'pl' check (lang in ('pl', 'en')),
  author_node uuid not null,
  contributor_id uuid,
  chat_conv uuid,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  posterior real not null default 0.5 check (posterior between 0 and 1),
  n_votes int not null default 0,
  n_true int not null default 0,
  decided_by text check (decided_by is null or decided_by in ('owner', 'votes')),
  frag_id bigint,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists myc_meanings_word on public.myc_meanings (room, lower(word));
create index if not exists myc_meanings_status on public.myc_meanings (room, status, created_at desc);

create table if not exists public.myc_meaning_votes (
  meaning_id bigint not null references public.myc_meanings (id) on delete cascade,
  voter_node uuid not null,
  contributor_id uuid,
  vote boolean not null,
  voter text not null check (voter in ('owner', 'person', 'agent')),
  acc real not null check (acc between 0.5 and 1),
  created_at timestamptz not null default now(),
  primary key (meaning_id, voter_node)
);

alter table public.myc_meanings enable row level security;
alter table public.myc_meaning_votes enable row level security;
revoke all on public.myc_meanings, public.myc_meaning_votes from anon, authenticated;
grant select on public.myc_meanings to anon, authenticated;
drop policy if exists myc_meanings_read on public.myc_meanings;
create policy myc_meanings_read on public.myc_meanings for select to anon, authenticated using (true);

-- Zapis wyjaśnienia (z czatu). Rejestr tylko z listy; ten sam autor nie dubluje tego samego znaczenia.
create or replace function public.myc_meaning_add(p_node uuid, p_contrib uuid, p_word text, p_meaning text, p_register text,
  p_example text, p_conv uuid, p_lang text default 'pl', p_room text default 'main')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w text := lower(btrim(regexp_replace(coalesce(p_word, ''), '\s+', ' ', 'g'))); m text := btrim(regexp_replace(coalesce(p_meaning, ''), '\s+', ' ', 'g')); id_ bigint;
begin
  if p_node is null then raise exception 'myc: node' using errcode = '22023'; end if;
  if p_room not in ('main', 'e2e') then raise exception 'myc: room' using errcode = '22023'; end if;
  perform myc_rl('meaning:' || p_node, 20);
  if char_length(w) not between 1 and 60 or char_length(m) not between 2 and 300 then raise exception 'myc: długość' using errcode = '22023'; end if;
  select id into id_ from myc_meanings where room = p_room and lower(word) = w and lower(meaning) = lower(m) and author_node = p_node;
  if id_ is not null then return jsonb_build_object('id', id_, 'status', 'pending', 'dup', true); end if;
  insert into myc_meanings (room, word, meaning, register, example, lang, author_node, contributor_id, chat_conv)
  values (p_room, w, left(m, 300), case when p_register in ('neutralne', 'potoczne', 'wulgarne', 'obraźliwe', 'slang', 'ironiczne') then p_register else 'neutralne' end,
          left(nullif(btrim(coalesce(p_example, '')), ''), 300), case when p_lang = 'en' then 'en' else 'pl' end, p_node, p_contrib, p_conv)
  returning id into id_;
  return jsonb_build_object('id', id_, 'status', 'pending');
end $$;
revoke all on function public.myc_meaning_add(uuid, uuid, text, text, text, text, uuid, text, text) from public;
grant execute on function public.myc_meaning_add(uuid, uuid, text, text, text, text, uuid, text, text) to anon, authenticated;

-- Głos: p_key właścicielki (albo testowy w pokoju e2e) = złota etykieta; bez klucza: człowiek; p_agent = agent węzła.
create or replace function public.myc_meaning_vote(p_key text, p_node uuid, p_contrib uuid, p_id bigint, p_vote boolean, p_agent boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m myc_meanings; kroom text := myc_key_room(p_key); who text; a real; n int; c int; lg double precision := 0; post real; nt int; nv int; fid bigint; k text; dec text;
begin
  if p_node is null or p_vote is null then raise exception 'myc: głos' using errcode = '22023'; end if;
  perform myc_rl('mvote:' || p_node, 120);
  select * into m from myc_meanings where id = p_id for update;
  if m.id is null then raise exception 'myc: brak znaczenia' using errcode = '22023'; end if;
  if m.status <> 'pending' and kroom is null then return jsonb_build_object('ok', false, 'reason', 'decided', 'status', m.status); end if;
  if m.author_node = p_node and kroom is null then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
  if kroom is not null then
    if kroom <> m.room then raise exception 'myc: klucz z innego pokoju' using errcode = '42501'; end if;
    who := 'owner'; a := 0.99;
  else
    select s.n, s.correct into n, c from myc_gold_stats() s where s.node_id = p_node;
    -- trafność na złotych etykietach z łagodnym a priori (Beta 3:1), agenci węzłów maks. 0,7
    a := least(greatest((coalesce(c, 0) + 3)::real / (coalesce(n, 0) + 4), 0.55), case when p_agent then 0.7 else 0.95 end);
    who := case when p_agent then 'agent' else 'person' end;
  end if;
  insert into myc_meaning_votes (meaning_id, voter_node, contributor_id, vote, voter, acc)
  values (m.id, p_node, p_contrib, p_vote, who, a)
  on conflict (meaning_id, voter_node) do update set vote = excluded.vote, acc = excluded.acc, voter = excluded.voter, created_at = now();
  select coalesce(sum(case when vote then 1 else -1 end * ln(acc / (1 - acc))), 0), count(*), count(*) filter (where vote)
    into lg, nv, nt from myc_meaning_votes where meaning_id = m.id and voter <> 'owner';
  post := (1 / (1 + exp(-lg)))::real;
  dec := null;
  if who = 'owner' then dec := case when p_vote then 'approved' else 'rejected' end;
  elsif nv >= 3 and post >= 0.95 then dec := 'approved';
  elsif nv >= 3 and post <= 0.05 then dec := 'rejected';
  end if;
  if dec = 'approved' then
    k := myc_frag_key(0, m.word, 'znaczenie', m.meaning);
    insert into myc_frags (room, layer, key, subj, rel, obj, lang, source, source_ref, trust, status, node_id)
    values (m.room, 0, k, m.word, 'znaczenie', m.meaning, m.lang, case when who = 'owner' then 'owner' else 'consensus' end,
            'meaning:' || m.id, case when who = 'owner' then 1 else least(post, 0.8) end, case when who = 'owner' then 'verified' else 'active' end, p_node)
    on conflict (room, key) do update set status = excluded.status, trust = greatest(myc_frags.trust, excluded.trust), updated_at = now()
    returning id into fid;
    if m.register <> 'neutralne' then
      insert into myc_frags (room, layer, key, subj, rel, obj, lang, source, source_ref, trust, status, node_id)
      values (m.room, 0, myc_frag_key(0, m.word, 'rejestr', m.register), m.word, 'rejestr', m.register, m.lang,
              case when who = 'owner' then 'owner' else 'consensus' end, 'meaning:' || m.id, case when who = 'owner' then 1 else least(post, 0.8) end, 'active', p_node)
      on conflict (room, key) do nothing;
    end if;
  elsif dec = 'rejected' and m.frag_id is not null then
    update myc_frags set status = 'rejected', trust = 0, updated_at = now() where id = m.frag_id;
  end if;
  update myc_meanings set posterior = case when who = 'owner' then (case when p_vote then 1 else 0 end) else post end,
         n_votes = nv + (case when who = 'owner' then 1 else 0 end), n_true = nt + (case when who = 'owner' and p_vote then 1 else 0 end),
         status = coalesce(dec, status), decided_by = case when dec is not null then (case when who = 'owner' then 'owner' else 'votes' end) else decided_by end,
         decided_at = case when dec is not null then now() else decided_at end, frag_id = coalesce(fid, frag_id)
   where id = m.id returning * into m;
  return jsonb_build_object('ok', true, 'voter', who, 'acc', a, 'posterior', m.posterior, 'status', m.status, 'votes', m.n_votes, 'frag', m.frag_id);
end $$;
revoke all on function public.myc_meaning_vote(text, uuid, uuid, bigint, boolean, boolean) from public;
grant execute on function public.myc_meaning_vote(text, uuid, uuid, bigint, boolean, boolean) to anon, authenticated;

-- Zatwierdzone znaczenia (do czatu i danych treningowych LM)
create or replace view public.myc_meanings_approved as
  select id, room, word, meaning, register, example, lang, decided_by, posterior, decided_at from public.myc_meanings where status = 'approved';
grant select on public.myc_meanings_approved to anon, authenticated;

-- Sprzątanie pokoju testów obejmuje też znaczenia
create or replace function public.myc_e2e_cleanup(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int; b int; c int;
begin
  if myc_key_room(p_key) is distinct from 'e2e' then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  delete from myc_reviews where room = 'e2e'; get diagnostics a = row_count;
  delete from myc_frags where room = 'e2e'; get diagnostics b = row_count;
  delete from myc_meanings where room = 'e2e'; get diagnostics c = row_count;
  return jsonb_build_object('reviews', a, 'frags', b, 'meanings', c);
end $$;
revoke all on function public.myc_e2e_cleanup(text) from public;
grant execute on function public.myc_e2e_cleanup(text) to anon, authenticated;

-- Reakcja „bzdura/pierdolisz” na odpowiedź czatu: oznacz własną, zapisaną (za zgodą) wymianę jako złą → Weryfikuj.
create or replace function public.myc_chat_flag(p_node uuid, p_conv uuid, p_turn int) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform myc_rl('chatflag:' || p_node, 30);
  update myc_chats set feedback = -1 where node_id = p_node and conv = p_conv and turn = p_turn and feedback is distinct from 1;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.myc_chat_flag(uuid, uuid, int) from public;
grant execute on function public.myc_chat_flag(uuid, uuid, int) to anon, authenticated;
