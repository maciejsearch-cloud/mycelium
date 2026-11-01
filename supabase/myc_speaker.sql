-- Grzybnia mówi sama (31.10.2026, decyzja właściciela): mówca AI w czacie globalnym (docs/speaker.md).
-- Co ok. minutę pg_cron wywołuje myc_speaker_tick(): generator programu nauczania (bez węzłów, bez chmury, w bazie)
-- składa zdanie/pytanie z jawnych list słów poziomu, a ludzie je oceniają, kategoryzują, etykietują, układają słowa
-- i poprawiają. Nic tu nie jest „udawanym” tekstem AI: każdy wpis ma zapisane tokeny, poziom i sposób powstania
-- (losowe / wyuczone / mutacja wyuczonego). Wyuczone = formy, które ludzie ocenili jako sensowne, i poprawki
-- z konsensusu (≥ 2 różne osoby z tą samą poprawką i ≥ 2/3 zgłoszeń). Do danych SFT trafia tylko konsensus
-- od osób z włączoną zgodą na naukę (myc_account_prefs.train_ok); głos przechowujemy ze skrótem konta, bez IP.
-- Poziomy: L0 dwa słowa (kto ja? / ja kto?), L1 krótkie pytania (ile ja lat? → ile mam lat?), L2 pytanie + odpowiedź,
-- L3 pytania o przypadki (kto/co/komu/gdzie/jak) na odmianie imion z ćwiczeń logiki (src/iot_mycelium/mesh/selfplay.py).
-- Awans: ≥ 20 ocenionych wpisów poziomu (z ostatnich 60) i ≥ 70% ocenionych większością jako sensowne.

alter table public.myc_gchat drop constraint if exists myc_gchat_kind_check;
alter table public.myc_gchat add constraint myc_gchat_kind_check check (kind in ('user', 'node', 'ai'));

create table if not exists public.myc_speaker (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,
  interval_s int not null default 60 check (interval_s between 60 and 3600),
  level int not null default 0 check (level between 0 and 3),
  last_post_at timestamptz,
  pending_answer bigint, -- L2: pytanie czekające na odpowiedź w następnym takcie
  updated_at timestamptz not null default now()
);
insert into public.myc_speaker (id) values (1) on conflict do nothing;

create table if not exists public.myc_speaker_posts (
  msg_id bigint primary key references public.myc_gchat (id) on delete cascade,
  level int not null check (level between 0 and 3),
  kind text not null check (kind in ('pytanie', 'odpowiedź', 'stwierdzenie')),
  tokens text[] not null check (cardinality(tokens) between 1 and 12),
  how text not null check (how in ('losowe', 'wyuczone', 'mutacja', 'rozbiór', 'czat')),
  pair_of bigint, -- odpowiedź na wpis (L2)
  created_at timestamptz not null default now()
);
create index if not exists myc_speaker_posts_lvl on public.myc_speaker_posts (level, msg_id desc);

create table if not exists public.myc_speaker_votes (
  msg_id bigint not null references public.myc_gchat (id) on delete cascade,
  voter text not null, -- md5 z solą konta (nie id konta)
  train_ok boolean not null,
  sense smallint check (sense in (-1, 1)),
  category text check (category in ('pytanie', 'odpowiedź', 'stwierdzenie')),
  task_type text check (task_type in ('logiczne', 'matematyczne', 'wzrokowe', 'analityczne', 'językowe', 'inne')),
  labels text[] not null default '{}' check (cardinality(labels) <= 5),
  word_order int[] check (word_order is null or cardinality(word_order) <= 12),
  fixed text check (fixed is null or char_length(fixed) between 1 and 200),
  answer text check (answer is null or char_length(answer) between 1 and 200),
  at timestamptz not null default now(),
  primary key (msg_id, voter)
);

-- formy wyuczone: zdania wygenerowane albo poprawione przez ludzi (konsensus), z wynikiem ocen
create table if not exists public.myc_speaker_forms (
  level int not null,
  text text not null check (char_length(text) between 1 and 200),
  source text not null check (source in ('gen', 'ludzie')),
  n_sense int not null default 0,
  n_nonsense int not null default 0,
  at timestamptz not null default now(),
  primary key (level, text)
);
-- dane do nauki (SFT) – tylko konsensus; trwałe (GC czatu ich nie usuwa)
create table if not exists public.myc_speaker_sft (
  id bigint generated always as identity primary key,
  level int not null,
  kind text not null check (kind in ('poprawka', 'odpowiedź', 'szyk')),
  prompt text not null check (char_length(prompt) between 1 and 200),
  target text not null check (char_length(target) between 1 and 200),
  category text,
  task_type text,
  n_agree int not null,
  n_total int not null,
  at timestamptz not null default now(),
  unique (prompt, kind, target)
);

alter table public.myc_speaker enable row level security;
alter table public.myc_speaker_posts enable row level security;
alter table public.myc_speaker_votes enable row level security;
alter table public.myc_speaker_forms enable row level security;
alter table public.myc_speaker_sft enable row level security;
revoke all on public.myc_speaker, public.myc_speaker_posts, public.myc_speaker_votes, public.myc_speaker_forms, public.myc_speaker_sft from public, anon, authenticated;
grant select on public.myc_speaker_posts, public.myc_speaker_sft to anon, authenticated;
drop policy if exists myc_speaker_posts_read on public.myc_speaker_posts;
create policy myc_speaker_posts_read on public.myc_speaker_posts for select to anon, authenticated using (true);
drop policy if exists myc_speaker_sft_read on public.myc_speaker_sft;
create policy myc_speaker_sft_read on public.myc_speaker_sft for select to anon, authenticated using (true);

-- kandydaci L0/L1 przefiltrowani modelem rozbioru LFG (GPL-3.0) + leksykonem; dane: myc_speaker_cands_data.sql
-- (generuje web/scripts/speaker-candidates.mjs). Ocena składni przez model, nie przez ludzi – dlatego osobne how='rozbiór'.
create table if not exists public.myc_speaker_cands (
  level int not null check (level between 0 and 3),
  text text not null,
  conf real not null,
  model text not null,
  at timestamptz not null default now(),
  primary key (level, text)
);
alter table public.myc_speaker_cands enable row level security;
revoke all on public.myc_speaker_cands from public, anon, authenticated;
alter table public.myc_speaker_posts drop constraint if exists myc_speaker_posts_how_check;
alter table public.myc_speaker_posts add constraint myc_speaker_posts_how_check check (how in ('losowe', 'wyuczone', 'mutacja', 'rozbiór', 'czat'));

create or replace function public.myc_spk_pick(a text[]) returns text language sql volatile as $$
  select a[1 + floor(random() * cardinality(a))::int]
$$;
create or replace function public.myc_spk_shuffle(a text[]) returns text[] language sql volatile as $$
  select coalesce(array_agg(x order by random()), '{}') from unnest(a) x
$$;
create or replace function public.myc_spk_norm(t text) returns text language sql immutable as $$
  select lower(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g'))
$$;
-- trafność poziomu: ostatnie 60 wpisów poziomu z ≥ 1 oceną (od osób ze zgodą); sensowny = więcej „sensowne” niż „bez sensu”
create or replace function public.myc_spk_level_acc(p_level int) returns table (rated int, sensible int, acc real)
language sql stable security definer set search_path = public, pg_temp as $$
  with p as (
    select s.msg_id, sum(v.sense) filter (where v.train_ok) sc, count(v.sense) filter (where v.train_ok) n
    from myc_speaker_posts s left join myc_speaker_votes v on v.msg_id = s.msg_id
    where s.level = p_level group by s.msg_id order by s.msg_id desc limit 200)
  , r as (select * from p where n > 0 order by msg_id desc limit 60)
  select count(*)::int, count(*) filter (where sc > 0)::int, case when count(*) > 0 then (count(*) filter (where sc > 0))::real / count(*) end from r
$$;

-- generator jednego wpisu poziomu (tokeny + sposób powstania); p_q = pytanie, na które odpowiada (L2)
create or replace function public.myc_spk_generate(p_level int, p_q bigint default null)
returns table (tokens text[], kind text, how text) language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  acc real := coalesce((select l.acc from myc_spk_level_acc(p_level) l), 0);
  f text; t text[]; qw text; qt text[];
  pron text[] := array['ja', 'ty', 'on', 'ona', 'my', 'wy', 'oni', 'to'];
  qwords text[] := array['kto', 'co', 'ile', 'gdzie', 'jak', 'kiedy', 'czy'];
  -- L3: imiona z odmianą (M, D, C, B) z ćwiczeń logiki
  nm text[][] := array[['Ala','Ali','Ali','Alę'],['Ewa','Ewy','Ewie','Ewę'],['Marta','Marty','Marcie','Martę'],
                        ['Adam','Adama','Adamowi','Adama'],['Bartek','Bartka','Bartkowi','Bartka'],['Janek','Janka','Jankowi','Janka']];
  obj text[] := array['książkę', 'jabłko', 'kwiat', 'list', 'piłkę'];
  vdat text[] := array['daje', 'pokazuje', 'wysyła', 'kupuje'];
  place text[] := array['w domu', 'w lesie', 'w szkole', 'w parku', 'nad morzem'];
  i int; j int; ci int; cj int;
begin
  -- eksploatacja (forma oceniona jako sensowna) z prawdopodobieństwem = trafność poziomu (maks. 0,8); reszta – eksploracja
  if p_q is null and random() < least(acc, 0.8) then
    select x.text into f from myc_speaker_forms x where x.level = p_level and x.n_sense > x.n_nonsense order by random() limit 1;
    if f is not null then
      t := regexp_split_to_array(f, '\s+');
      if random() < 0.3 and cardinality(t) > 1 then -- mutacja: zamiana dwóch sąsiednich słów
        i := 1 + floor(random() * (cardinality(t) - 1))::int;
        f := t[i]; t[i] := t[i + 1]; t[i + 1] := f;
        return query select t, case when t[cardinality(t)] like '%?' then 'pytanie' else 'stwierdzenie' end, 'mutacja'; return;
      end if;
      return query select t, case when f like '%?' then 'pytanie' else 'stwierdzenie' end, 'wyuczone'; return;
    end if;
  end if;
  -- eksploracja L0/L1: w 25% krótkie pytanie osoby z czatu (myc_speaker_chatq, za zgodą; how='czat'), o sensie dalej decydują oceny
  if p_q is null and p_level <= 1 and random() < 0.25 then
    select x.text into f from myc_speaker_chatq x where x.level = p_level order by random() limit 1;
    if f is not null then
      return query select regexp_split_to_array(f, '\s+'), 'pytanie', 'czat'; return;
    end if;
  end if;
  -- eksploracja L0/L1: w 60% kandydat zaakceptowany przez model rozbioru, w 40% nadal losowe (kontrola do porównania ocen)
  if p_q is null and p_level <= 1 and random() < 0.6 then
    select x.text into f from myc_speaker_cands x where x.level = p_level order by random() limit 1;
    if f is not null then
      return query select regexp_split_to_array(f, '\s+'), 'pytanie', 'rozbiór'; return;
    end if;
  end if;
  if p_level = 0 then
    t := myc_spk_shuffle(array[myc_spk_pick(qwords), myc_spk_pick(pron)]);
    t[2] := t[2] || '?';
    return query select t, 'pytanie', 'losowe'; return;
  elsif p_level = 1 or (p_level = 2 and p_q is null) then
    qw := myc_spk_pick(array['ile', 'kto', 'gdzie', 'jak', 'co', 'czy']);
    qt := case qw
      when 'ile' then array['ja', 'ty', 'mam', 'masz', 'ma', 'lat', 'dni', 'jest']
      when 'kto' then array['ja', 'ty', 'jest', 'jestem', 'jesteś', 'tam', 'to', 'mówi']
      when 'gdzie' then array['ja', 'ty', 'jestem', 'jesteś', 'mieszkasz', 'mieszkam', 'jest', 'dom']
      when 'jak' then array['ty', 'masz', 'mam', 'na', 'imię', 'się', 'czujesz', 'czuję']
      when 'co' then array['ty', 'ja', 'robisz', 'robię', 'lubisz', 'to', 'jest', 'masz']
      else array['ty', 'ja', 'jesteś', 'jestem', 'lubisz', 'masz', 'tu', 'grzybnia'] end;
    t := (myc_spk_shuffle(qt))[1:1 + floor(random() * 3)::int];
    -- słowo pytające zwykle na początku; im wyższa trafność, tym rzadziej przestawiane
    if random() < 0.5 + acc / 2 then t := array[qw] || t; else t := t || array[qw]; end if;
    t[cardinality(t)] := t[cardinality(t)] || '?';
    return query select t, 'pytanie', 'losowe'; return;
  elsif p_level = 2 then
    -- odpowiedź: najpierw odpowiedź ludzi z konsensusu na to samo pytanie, inaczej złożona ze słów odpowiedzi
    select s.target into f from myc_speaker_sft s join myc_gchat g on myc_spk_norm(g.body) = s.prompt
      where g.id = p_q and s.kind = 'odpowiedź' order by s.n_agree desc limit 1;
    if f is not null then return query select regexp_split_to_array(f, '\s+'), 'odpowiedź', 'wyuczone'; return; end if;
    qw := (select myc_spk_norm(split_part(g.body, ' ', 1)) from myc_gchat g where g.id = p_q);
    qt := case
      when qw like 'ile%' then array[myc_spk_pick(array['mam', 'masz', 'ma', 'jest']), myc_spk_pick(array['jeden', 'dwa', 'pięć', 'dziesięć', 'sto']), myc_spk_pick(array['lat', 'lata', 'dni', 'dzień'])]
      when qw like 'gdzie%' then array[myc_spk_pick(array['mieszkam', 'jestem', 'jest']), myc_spk_pick(array['w', 'na', 'pod']), myc_spk_pick(array['sieci', 'domu', 'lesie', 'mieście', 'ziemi'])]
      when qw like 'kto%' then array[myc_spk_pick(array['jestem', 'to', 'jest']), myc_spk_pick(array['ja', 'grzybnia', 'człowiek', 'Ala', 'nikt'])]
      when qw like 'jak%' then array[myc_spk_pick(array['mam', 'czuję', 'jest']), myc_spk_pick(array['się', 'na', 'dobrze', 'imię']), myc_spk_pick(array['dobrze', 'Grzybnia', 'źle', 'imię'])]
      else array[myc_spk_pick(array['tak', 'nie', 'nie wiem', 'może'])] end;
    if random() > 0.5 + acc / 2 then qt := myc_spk_shuffle(qt); end if;
    qt[cardinality(qt)] := qt[cardinality(qt)] || '.';
    return query select qt, 'odpowiedź', 'losowe'; return;
  else
    i := 1 + floor(random() * 6)::int; j := 1 + ((i + floor(random() * 5)::int) % 6);
    -- przypadek imienia: poprawny z prawdopodobieństwem 0,4 + 0,6·trafność, inaczej losowy (uczenie odmiany)
    ci := case when random() < 0.4 + 0.6 * acc then 1 else 1 + floor(random() * 4)::int end;
    cj := case when random() < 0.4 + 0.6 * acc then 3 else 1 + floor(random() * 4)::int end;
    qw := myc_spk_pick(array['kto', 'komu', 'co', 'gdzie', 'stwierdzenie']);
    t := case qw
      when 'kto' then array['Kto', myc_spk_pick(vdat), nm[j][cj], myc_spk_pick(obj) || '?']
      when 'komu' then array['Komu', nm[i][ci], myc_spk_pick(vdat), myc_spk_pick(obj) || '?']
      when 'co' then array['Co', nm[i][ci], myc_spk_pick(vdat), nm[j][cj] || '?']
      when 'gdzie' then array['Gdzie', 'jest', nm[i][ci] || '?']
      else array[nm[i][ci], myc_spk_pick(vdat), nm[j][cj], myc_spk_pick(obj), myc_spk_pick(place) || '.'] end;
    return query select t, case when qw = 'stwierdzenie' then 'stwierdzenie' else 'pytanie' end, 'losowe'; return;
  end if;
end $$;

create or replace function public.myc_speaker_tick() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s myc_speaker; g record; mid bigint; lv int; a record; body text;
begin
  select * into s from myc_speaker where id = 1 for update;
  if not s.enabled then return jsonb_build_object('ok', false, 'why', 'paused'); end if;
  -- trwa rozmowa ludzi (wiadomość w ostatnich 3 min): mówca nie przerywa – odpowiada rozmówca (myc_rozmowa.sql)
  if exists (select 1 from myc_gchat where room = 'main' and circle_id is null and kind = 'user' and created_at > now() - interval '3 minutes') then
    return jsonb_build_object('ok', false, 'why', 'rozmowa');
  end if;
  if s.last_post_at is not null and now() - s.last_post_at < make_interval(secs => s.interval_s - 5) then
    return jsonb_build_object('ok', false, 'why', 'interval');
  end if;
  -- awans poziomu (tylko w górę; Developer może ustawić ręcznie)
  select * into a from myc_spk_level_acc(s.level);
  if s.level < 3 and a.rated >= 20 and a.acc >= 0.7 then
    update myc_speaker set level = level + 1 where id = 1;
    insert into myc_mod_log (room, actor_role, action, detail) values ('main', 'system', 'speaker_level', jsonb_build_object('from', s.level, 'to', s.level + 1, 'acc', a.acc, 'rated', a.rated));
    s.level := s.level + 1;
  end if;
  lv := s.level;
  if lv = 2 and s.pending_answer is not null and exists (select 1 from myc_gchat where id = s.pending_answer and not deleted) then
    select * into g from myc_spk_generate(2, s.pending_answer);
  else
    s.pending_answer := null;
    select * into g from myc_spk_generate(lv);
  end if;
  body := array_to_string(g.tokens, ' ');
  insert into myc_gchat (room, kind, handle, body, reply_to, intent)
    values ('main', 'ai', 'Grzybnia AI', body, s.pending_answer, case when g.kind = 'pytanie' then 'pytanie' else 'stwierdzenie' end)
    returning id into mid;
  insert into myc_speaker_posts (msg_id, level, kind, tokens, how, pair_of) values (mid, lv, g.kind, g.tokens, g.how, s.pending_answer);
  insert into myc_speaker_forms (level, text, source) values (lv, body, 'gen') on conflict do nothing;
  update myc_speaker set last_post_at = now(), updated_at = now(),
    pending_answer = case when lv = 2 and s.pending_answer is null and g.kind = 'pytanie' then mid end where id = 1;
  -- GC: nieocenione wpisy AI starsze niż 3 dni, wszystkie starsze niż 30 dni (konsensus i formy zostają w swoich tabelach)
  delete from myc_gchat m where m.kind = 'ai' and m.created_at < now() - interval '3 days'
    and (m.created_at < now() - interval '30 days' or not exists (select 1 from myc_speaker_votes v where v.msg_id = m.id));
  delete from myc_speaker_forms f where f.source = 'gen' and f.n_sense = 0 and f.n_nonsense = 0 and f.at < now() - interval '3 days';
  return jsonb_build_object('ok', true, 'msg', mid, 'level', lv, 'text', body, 'how', g.how);
end $$;
revoke execute on function public.myc_speaker_tick() from public, anon, authenticated;
revoke execute on function public.myc_spk_generate(int, bigint) from public, anon, authenticated;
revoke execute on function public.myc_spk_level_acc(int) from public, anon, authenticated;

-- ocena wpisu AI przez człowieka (konto czatu); jeden wiersz na osobę i wpis, kolejne wywołania uzupełniają pola
create or replace function public.myc_speaker_rate(p_msg bigint, p_sense smallint default null, p_category text default null,
  p_task text default null, p_labels text[] default null, p_order int[] default null, p_fixed text default null, p_answer text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); ok boolean; vh text; p myc_speaker_posts; fx text; an text; lb text[]; ord text;
  n_tot int; n_top int; top text; prm text; was smallint;
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: brak konta' using errcode = '42501'; end if;
  perform myc_rl('spk:' || acc, 30);
  select * into p from myc_speaker_posts where msg_id = p_msg;
  if p.msg_id is null then raise exception 'myc: to nie jest wpis AI' using errcode = '22023'; end if;
  ok := coalesce((select train_ok from myc_account_prefs where account_id = acc), true);
  vh := md5('myc-spk-v1' || acc::text);
  fx := left(nullif(btrim(coalesce(p_fixed, '')), ''), 200);
  an := left(nullif(btrim(coalesce(p_answer, '')), ''), 200);
  lb := (select array_agg(distinct left(lower(btrim(x)), 24)) from unnest(coalesce(p_labels, '{}')) x where btrim(x) <> '');
  if cardinality(lb) > 5 then lb := lb[1:5]; end if;
  if p_order is not null and (cardinality(p_order) <> cardinality(p.tokens)
      or (select array_agg(x order by x) from unnest(p_order) x) <> (select array_agg(i) from generate_series(1, cardinality(p.tokens)) i)) then
    raise exception 'myc: zła kolejność słów' using errcode = '22023';
  end if;
  select sense into was from myc_speaker_votes where msg_id = p_msg and voter = vh;
  insert into myc_speaker_votes as v (msg_id, voter, train_ok, sense, category, task_type, labels, word_order, fixed, answer)
  values (p_msg, vh, ok, p_sense, p_category, p_task, coalesce(lb, '{}'), p_order, fx, an)
  on conflict (msg_id, voter) do update set train_ok = ok, sense = coalesce(excluded.sense, v.sense), category = coalesce(excluded.category, v.category),
    task_type = coalesce(excluded.task_type, v.task_type), labels = case when p_labels is null then v.labels else excluded.labels end,
    word_order = coalesce(excluded.word_order, v.word_order), fixed = coalesce(excluded.fixed, v.fixed), answer = coalesce(excluded.answer, v.answer), at = now();
  -- wynik formy (tylko osoby ze zgodą; zmiana oceny poprawia licznik)
  if ok and p_sense is not null and p_sense is distinct from was then
    update myc_speaker_forms set n_sense = n_sense + (p_sense = 1)::int - coalesce((was = 1)::int, 0),
      n_nonsense = n_nonsense + (p_sense = -1)::int - coalesce((was = -1)::int, 0)
      where level = p.level and text = array_to_string(p.tokens, ' ');
  end if;
  -- konsensus (≥ 2 osoby ze zgodą, ≥ 2/3 zgłoszeń) → dane SFT i forma wyuczona
  prm := array_to_string(p.tokens, ' ');
  foreach top in array array['poprawka', 'odpowiedź', 'szyk'] loop
    select sum(c), max(c) into n_tot, n_top from (
      select count(*) c from myc_speaker_votes v where v.msg_id = p_msg and v.train_ok and
        case top when 'poprawka' then v.fixed is not null when 'odpowiedź' then v.answer is not null else v.word_order is not null end
      group by case top when 'poprawka' then myc_spk_norm(v.fixed) when 'odpowiedź' then myc_spk_norm(v.answer) else v.word_order::text end) z;
    if n_top >= 2 and n_top * 3 >= n_tot * 2 then
      select k into ord from (
        select case top when 'poprawka' then myc_spk_norm(v.fixed) when 'odpowiedź' then myc_spk_norm(v.answer) else v.word_order::text end k
        from myc_speaker_votes v where v.msg_id = p_msg and v.train_ok and
          case top when 'poprawka' then v.fixed is not null when 'odpowiedź' then v.answer is not null else v.word_order is not null end) z
        group by k order by count(*) desc limit 1;
      if top = 'szyk' then
        select string_agg(regexp_replace(p.tokens[o], '[?.!]$', ''), ' ' order by i) || coalesce(substring(p.tokens[cardinality(p.tokens)] from '[?.!]$'), '')
          into ord from unnest(ord::int[]) with ordinality u(o, i);
      end if;
      insert into myc_speaker_sft (level, kind, prompt, target, category, task_type, n_agree, n_total)
        values (p.level, top, myc_spk_norm(prm), ord,
          (select category from myc_speaker_votes where msg_id = p_msg and train_ok and category is not null group by 1 order by count(*) desc limit 1),
          (select task_type from myc_speaker_votes where msg_id = p_msg and train_ok and task_type is not null group by 1 order by count(*) desc limit 1),
          n_top, n_tot)
        on conflict (prompt, kind, target) do update set n_agree = excluded.n_agree, n_total = excluded.n_total, at = now();
      if top <> 'odpowiedź' then
        insert into myc_speaker_forms (level, text, source, n_sense) values (p.level, ord, 'ludzie', n_top)
          on conflict (level, text) do update set n_sense = greatest(myc_speaker_forms.n_sense, excluded.n_sense), source = 'ludzie';
      end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'train_ok', ok);
end $$;

-- podsumowanie ocen wpisów AI dla interfejsu (bez kont)
create or replace function public.myc_speaker_summary(p_ids bigint[]) returns table (msg_id bigint, level int, how text, tokens text[],
  sense int, nonsense int, n int, category text, task_type text, labels text[], fixes jsonb, answers jsonb, mine jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.msg_id, s.level, s.how, s.tokens,
    (count(*) filter (where v.sense = 1))::int, (count(*) filter (where v.sense = -1))::int, count(v.voter)::int,
    mode() within group (order by v.category), mode() within group (order by v.task_type),
    (select array_agg(distinct l) from myc_speaker_votes w, unnest(w.labels) l where w.msg_id = s.msg_id),
    (select jsonb_agg(jsonb_build_object('t', t, 'n', c) order by c desc) from (select myc_spk_norm(w.fixed) t, count(*) c from myc_speaker_votes w where w.msg_id = s.msg_id and w.fixed is not null group by 1 limit 5) f),
    (select jsonb_agg(jsonb_build_object('t', t, 'n', c) order by c desc) from (select myc_spk_norm(w.answer) t, count(*) c from myc_speaker_votes w where w.msg_id = s.msg_id and w.answer is not null group by 1 limit 5) f),
    (select to_jsonb(w) - 'voter' - 'msg_id' from myc_speaker_votes w where w.msg_id = s.msg_id and myc_acct_id() is not null and w.voter = md5('myc-spk-v1' || myc_acct_id()::text))
  from myc_speaker_posts s left join myc_speaker_votes v on v.msg_id = s.msg_id
  where s.msg_id = any (p_ids[1:200]) group by s.msg_id
$$;

create or replace function public.myc_speaker_state() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('enabled', s.enabled, 'interval_s', s.interval_s, 'level', s.level, 'last_post_at', s.last_post_at,
    'levels', (select jsonb_agg(jsonb_build_object('level', l, 'posts', (select count(*) from myc_speaker_posts p where p.level = l),
        'rated', a.rated, 'sensible', a.sensible, 'acc', a.acc) order by l) from generate_series(0, 3) l, lateral myc_spk_level_acc(l) a),
    'sft', (select count(*) from myc_speaker_sft), 'forms_people', (select count(*) from myc_speaker_forms where source = 'ludzie'),
    'votes', (select count(*) from myc_speaker_votes), 'opted_out_votes', (select count(*) from myc_speaker_votes where not train_ok))
  from myc_speaker s where s.id = 1
$$;

-- sterowanie (tylko Developer): pause / resume / interval (s) / level / purge (usuń wpisy AI) / remove (wyłącz i usuń)
create or replace function public.myc_speaker_admin(p_action text, p_value int default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); n int := 0;
begin
  perform myc_acct_uid();
  if acc is null or myc_role_of(acc) is distinct from 'developer' or (select room from myc_accounts where id = acc) <> 'main' then
    raise exception 'myc: tylko Developer' using errcode = '42501';
  end if;
  if p_action = 'pause' then update myc_speaker set enabled = false, updated_at = now() where id = 1;
  elsif p_action = 'resume' then update myc_speaker set enabled = true, updated_at = now() where id = 1;
  elsif p_action = 'interval' and p_value between 60 and 3600 then update myc_speaker set interval_s = p_value, updated_at = now() where id = 1;
  elsif p_action = 'level' and p_value between 0 and 3 then update myc_speaker set level = p_value, pending_answer = null, updated_at = now() where id = 1;
  elsif p_action in ('purge', 'remove') then
    if p_action = 'remove' then update myc_speaker set enabled = false, pending_answer = null, updated_at = now() where id = 1; end if;
    delete from myc_gchat where kind = 'ai'; get diagnostics n = row_count;
  else raise exception 'myc: zła akcja' using errcode = '22023';
  end if;
  insert into myc_mod_log (room, actor, actor_role, action, detail) values ('main', acc, 'developer', 'speaker_' || p_action, jsonb_build_object('value', p_value, 'deleted', n));
  return myc_speaker_state();
end $$;

revoke execute on function public.myc_speaker_rate(bigint, smallint, text, text, text[], int[], text, text) from public, anon;
grant execute on function public.myc_speaker_rate(bigint, smallint, text, text, text[], int[], text, text) to authenticated;
revoke execute on function public.myc_speaker_admin(text, int) from public, anon;
grant execute on function public.myc_speaker_admin(text, int) to authenticated;
revoke execute on function public.myc_speaker_summary(bigint[]) from public;
grant execute on function public.myc_speaker_summary(bigint[]) to anon, authenticated;
revoke execute on function public.myc_speaker_state() from public;
grant execute on function public.myc_speaker_state() to anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'myc_speaker') then perform cron.unschedule('myc_speaker'); end if;
  perform cron.schedule('myc_speaker', '* * * * *', 'select public.myc_speaker_tick()');
end $$;
