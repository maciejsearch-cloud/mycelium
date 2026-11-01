-- „Model logiczny tego, jak ludzie piszą”: wzorce komunikacji z czatu globalnego → kandydaci do Weryfikuj.
-- Uczymy się ZBIORCZYCH wzorców języka, nie profili osób:
--  • tylko wiadomości kont z włączonym przełącznikiem „moje wiadomości uczą model” (myc_account_prefs.train_ok),
--  • przed czymkolwiek treść jest czyszczona (myc_scrub): linki, e-maile, telefony, @wzmianki i pseudonimy → znaczniki,
--  • wzorzec słowny (skrót, emotikon, wydłużenie) zostaje kandydatem dopiero, gdy użyły go ≥ 2 RÓŻNE konta;
--    licznik autorów trzyma skrót md5(sól ‖ konto ‖ token) – innego dla każdego tokenu, więc nie da się
--    złożyć listy „co pisze osoba X”,
--  • próbki intencji (pytanie / emocja / niezgoda / ironia) to pojedyncze, wyczyszczone zdania; po wyłączeniu
--    przełącznika oczekujące próbki z moich wiadomości są usuwane,
--  • nic nie staje się wiedzą bez głosowania „prawda / kłamstwo” (wagi zaufania jak przy znaczeniach; głos Developera
--    lub klucza właściciela = złota etykieta). Zatwierdzone → strzępki (source 'chat') i dane treningowe (eksport).

create table if not exists public.myc_lang_patterns (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  kind text not null check (kind in ('skrót', 'emotikon', 'wydłużenie', 'intencja', 'ironia')),
  pattern text not null check (char_length(pattern) between 1 and 200),
  label text not null check (char_length(label) between 1 and 60),
  example text check (example is null or char_length(example) <= 200),
  n_seen int not null default 1,
  n_authors int not null default 1,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  posterior real not null default 0.5 check (posterior between 0 and 1),
  n_votes int not null default 0,
  n_true int not null default 0,
  decided_by text check (decided_by is null or decided_by in ('owner', 'votes')),
  frag_id bigint,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists myc_lang_patterns_uq on public.myc_lang_patterns (room, kind, lower(pattern));
create index if not exists myc_lang_patterns_status on public.myc_lang_patterns (room, status, created_at desc);

create table if not exists public.myc_lang_votes (
  pattern_id bigint not null references public.myc_lang_patterns (id) on delete cascade,
  voter_node uuid not null,
  vote boolean not null,
  voter text not null check (voter in ('owner', 'person', 'agent')),
  acc real not null check (acc between 0.5 and 1),
  created_at timestamptz not null default now(),
  primary key (pattern_id, voter_node)
);
-- skąd próbka (prywatne; tylko do usunięcia przy wyłączeniu zgody)
create table if not exists public.myc_lang_src (
  pattern_id bigint not null references public.myc_lang_patterns (id) on delete cascade,
  msg_id bigint not null references public.myc_gchat (id) on delete cascade,
  primary key (pattern_id, msg_id)
);
-- k-anonimowość wzorców słownych: (token, skrót autora zależny od tokenu)
create table if not exists public.myc_lang_seen (
  room text not null,
  kind text not null,
  token text not null,
  author_hash text not null,
  primary key (room, kind, token, author_hash)
);

alter table public.myc_lang_patterns enable row level security;
alter table public.myc_lang_votes enable row level security;
alter table public.myc_lang_src enable row level security;
alter table public.myc_lang_seen enable row level security;
revoke all on public.myc_lang_patterns, public.myc_lang_votes, public.myc_lang_src, public.myc_lang_seen from public, anon, authenticated;
grant select on public.myc_lang_patterns to anon, authenticated;
drop policy if exists myc_lang_patterns_read on public.myc_lang_patterns;
create policy myc_lang_patterns_read on public.myc_lang_patterns for select to anon, authenticated using (true);

create or replace view public.myc_lang_approved with (security_invoker = true) as
  select id, room, kind, pattern, label, example, n_authors, posterior, decided_by, decided_at from public.myc_lang_patterns where status = 'approved';
revoke all on public.myc_lang_approved from anon, authenticated;
grant select on public.myc_lang_approved to anon, authenticated;

-- Czyszczenie danych osobowych z próbek
create or replace function public.myc_scrub(p_text text, p_room text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t text := coalesce(p_text, '');
begin
  t := regexp_replace(t, '(https?://|www\.)\S+', '<link>', 'gi');
  t := regexp_replace(t, '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}', '<email>', 'g');
  t := regexp_replace(t, '\+?\d[\d \(\)./-]{5,}\d', '<telefon>', 'g');
  t := regexp_replace(t, '@[[:alnum:]_.-]{2,}', '<osoba>', 'g');
  t := regexp_replace(t, 'węzeł·[0-9a-f]{6}', '<węzeł>', 'g');
  select coalesce(string_agg(case when exists (select 1 from myc_accounts a where a.room = p_room
           and lower(a.handle) = lower(regexp_replace(w, '^[^[:alnum:]_]+|[^[:alnum:]_]+$', '', 'g'))) then '<osoba>' else w end, ' ' order by o), '')
    into t from regexp_split_to_table(btrim(t), '\s+') with ordinality x(w, o);
  return t;
end $$;
revoke execute on function public.myc_scrub(text, text) from public, anon, authenticated;

-- Ekstrakcja (pg_cron co 10 min): nowe wiadomości → wzorce słowne (k ≥ 2 autorów) i próbki intencji.
create or replace function public.myc_lang_extract(p_max int default 500, p_room text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare r record; t text; tok text; raw text; k text; lab text; need int; na int; nw int := 0; ni int := 0; nmsg int := 0; pid bigint;
begin
  for r in select m.id, m.room, m.body, m.intent, m.tags, p.account_id
             from myc_gchat_priv p join myc_gchat m on m.id = p.msg_id
            where p.processed_at is null and (p_room is null or m.room = p_room) order by p.msg_id limit p_max loop
    nmsg := nmsg + 1;
    update myc_gchat_priv set processed_at = now() where msg_id = r.id;
    continue when r.body is null or r.account_id is null
      or not coalesce((select train_ok from myc_gchat_priv where msg_id = r.id), false)
      or not coalesce((select train_ok from myc_account_prefs where account_id = r.account_id), true);
    t := myc_scrub(r.body, r.room);
    need := case when r.room = 'e2e' then 1 else 2 end;
    -- wzorce słowne
    for raw in select distinct x from regexp_split_to_table(t, '\s+') x where x <> '' limit 60 loop
      continue when raw ~ '^<(link|email|telefon|osoba|węzeł)>';
      tok := lower(regexp_replace(raw, '^[,.!?„”"''()]+|[,.!?„”"''()]+$', '', 'g'));
      k := null;
      if raw ~ '^(:-?[\)\(DPpO/|]+|;-?[\)D]+|[xX][dD]+|<3+|\^\^|:3|T_T|:\*)[!.?]*$' or raw ~ '[\U0001F300-\U0001FAFF\u2600-\u27BF]' then
        k := 'emotikon'; tok := lower(regexp_replace(raw, '[!.?,]+$', '')); lab := 'emotikon / znak emocji';
      elsif char_length(tok) between 3 and 30 and tok ~ '([[:alpha:]])\1\1' then
        k := 'wydłużenie'; lab := 'wydłużenie dla emocji: ' || regexp_replace(tok, '([[:alpha:]])\1{2,}', '\1', 'g');
      elsif (tok ~ '^[bcćdfghjklłmnńprsśtwzźż]{2,5}$' or regexp_replace(raw, '[,.!?]+$', '') ~ '^[A-ZĄĆĘŁŃÓŚŹŻ]{2,5}$') and tok !~ '^(w|z|i|a|o|u)$' then
        k := 'skrót'; lab := 'skrót czatu';
      end if;
      continue when k is null or char_length(tok) not between 1 and 40;
      insert into myc_lang_seen (room, kind, token, author_hash)
      values (r.room, k, tok, md5('myc-lang-v1' || r.account_id || tok)) on conflict do nothing;
      select count(*) into na from myc_lang_seen where room = r.room and kind = k and token = tok;
      update myc_lang_patterns set n_seen = n_seen + 1, n_authors = greatest(n_authors, na)
       where room = r.room and kind = k and lower(pattern) = tok;
      if not found and na >= need then
        insert into myc_lang_patterns (room, kind, pattern, label, example, n_seen, n_authors)
        values (r.room, k, tok, lab, left(t, 200), na, na) on conflict do nothing;
        nw := nw + 1;
      end if;
    end loop;
    -- próbki intencji / ironii (zdanie wyczyszczone, 2–160 znaków)
    if char_length(t) between 2 and 160 and (r.intent in ('pytanie', 'emocja', 'niezgoda', 'ironia') or 'ironiczne' = any (r.tags)) then
      k := case when r.intent = 'ironia' or 'ironiczne' = any (r.tags) then 'ironia' else 'intencja' end;
      lab := case when k = 'ironia' then 'ironia / sarkazm' else r.intent end;
      insert into myc_lang_patterns (room, kind, pattern, label, example) values (r.room, k, t, lab, null)
        on conflict (room, kind, lower(pattern)) do update set n_seen = myc_lang_patterns.n_seen + 1 returning id into pid;
      insert into myc_lang_src (pattern_id, msg_id) values (pid, r.id) on conflict do nothing;
      ni := ni + 1;
    end if;
  end loop;
  return jsonb_build_object('messages', nmsg, 'word_patterns', nw, 'intent_samples', ni);
end $$;
revoke execute on function public.myc_lang_extract(int, text) from public, anon, authenticated;

-- Głos „prawda / kłamstwo” na wzorzec. Złota etykieta: klucz właściciela (p_key) albo zalogowany Developer.
create or replace function public.myc_lang_vote(p_key text, p_node uuid, p_id bigint, p_vote boolean, p_agent boolean default false, p_label text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m myc_lang_patterns; kroom text := myc_key_room(p_key); who text; a real; n int; c int; lg double precision := 0; post real; nt int; nv int; fid bigint; dec text; rel text;
begin
  if p_node is null or p_vote is null then raise exception 'myc: głos' using errcode = '22023'; end if;
  perform myc_rl('lvote:' || p_node, 120);
  select * into m from myc_lang_patterns where id = p_id for update;
  if m.id is null then raise exception 'myc: brak wzorca' using errcode = '22023'; end if;
  if kroom is null and myc_role_of(myc_acct_id()) = 'developer' then kroom := (select room from myc_accounts where id = myc_acct_id()); end if;
  if m.status <> 'pending' and kroom is null then return jsonb_build_object('ok', false, 'reason', 'decided', 'status', m.status); end if;
  if kroom is not null then
    if kroom <> m.room then raise exception 'myc: inny pokój' using errcode = '42501'; end if;
    who := 'owner'; a := 0.99;
    -- poprawka etykiety intencji przez Developera (np. to nie „pytanie”, tylko „niezgoda”)
    if p_label in ('pytanie', 'emocja', 'niezgoda', 'stwierdzenie', 'powitanie') and m.kind = 'intencja' then
      update myc_lang_patterns set label = p_label where id = m.id returning * into m;
    end if;
  else
    select s.n, s.correct into n, c from myc_gold_stats() s where s.node_id = p_node;
    a := least(greatest((coalesce(c, 0) + 3)::real / (coalesce(n, 0) + 4), 0.55), case when p_agent then 0.7 else 0.95 end);
    who := case when p_agent then 'agent' else 'person' end;
  end if;
  insert into myc_lang_votes (pattern_id, voter_node, vote, voter, acc) values (m.id, p_node, p_vote, who, a)
  on conflict (pattern_id, voter_node) do update set vote = excluded.vote, acc = excluded.acc, voter = excluded.voter, created_at = now();
  select coalesce(sum(case when vote then 1 else -1 end * ln(acc / (1 - acc))), 0), count(*), count(*) filter (where vote)
    into lg, nv, nt from myc_lang_votes where pattern_id = m.id and voter <> 'owner';
  post := (1 / (1 + exp(-lg)))::real;
  if who = 'owner' then dec := case when p_vote then 'approved' else 'rejected' end;
  elsif nv >= 3 and post >= 0.95 then dec := 'approved';
  elsif nv >= 3 and post <= 0.05 then dec := 'rejected';
  end if;
  rel := case m.kind when 'skrót' then 'pattern_abbr' when 'emotikon' then 'pattern_emoticon' when 'wydłużenie' then 'pattern_elong' when 'intencja' then 'intent' else 'irony' end;
  if dec = 'approved' then
    insert into myc_frags (room, layer, key, subj, rel, obj, lang, source, source_ref, trust, status)
    values (m.room, 0, myc_frag_key(0, left(m.pattern, 160), rel, m.label), left(m.pattern, 160), rel, m.label, 'pl', 'chat', 'lang:' || m.id,
            case when who = 'owner' then 1 else least(post, 0.8) end, case when who = 'owner' then 'verified' else 'active' end)
    on conflict (room, key) do update set status = excluded.status, trust = greatest(myc_frags.trust, excluded.trust), updated_at = now()
    returning id into fid;
  elsif dec = 'rejected' and m.frag_id is not null then
    update myc_frags set status = 'rejected', trust = 0, updated_at = now() where id = m.frag_id;
  end if;
  update myc_lang_patterns set posterior = case when who = 'owner' then (case when p_vote then 1 else 0 end) else post end,
         n_votes = nv + (case when who = 'owner' then 1 else 0 end), n_true = nt + (case when who = 'owner' and p_vote then 1 else 0 end),
         status = coalesce(dec, status), decided_by = case when dec is not null then (case when who = 'owner' then 'owner' else 'votes' end) else decided_by end,
         decided_at = case when dec is not null then now() else decided_at end, frag_id = coalesce(fid, frag_id)
   where id = m.id returning * into m;
  return jsonb_build_object('ok', true, 'voter', who, 'posterior', m.posterior, 'status', m.status, 'votes', m.n_votes, 'label', m.label);
end $$;
revoke all on function public.myc_lang_vote(text, uuid, bigint, boolean, boolean, text) from public;
grant execute on function public.myc_lang_vote(text, uuid, bigint, boolean, boolean, text) to anon, authenticated;

-- e2e: ręczne uruchomienie ekstrakcji w pokoju testów (kluczem e2e) – pokój main tylko pg_cron.
create or replace function public.myc_lang_extract_e2e(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if myc_key_room(p_key) is distinct from 'e2e' then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  return myc_lang_extract(200, 'e2e');
end $$;
revoke all on function public.myc_lang_extract_e2e(text) from public;
grant execute on function public.myc_lang_extract_e2e(text) to anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'myc_lang_extract';
select cron.schedule('myc_lang_extract', '*/10 * * * *', $$select public.myc_lang_extract()$$);
