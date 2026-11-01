-- Wymaga supabase/myc_rel_banned.sql (myc_rel_banned, myc_rel_has_banned) – zastosuj go najpierw.
-- Pytania o relacje dla czystej grzybni (docs/czysta-grzybnia.md, „Naucz relacji”).
-- Proponują je mówca „Grzybnia AI” (myc_rel_speaker_tick, pg_cron) i samouk (scripts/relacje_samouk.py przez
-- Management API). To są TYLKO pytania: odpowiedź człowiek pisze pełnym zdaniem w zakładce Czysta grzybnia,
-- zdanie trafia do Ucz AI → Weryfikuj i staje się wiedzą dopiero po konsensusie. Nic tu nie jest zatwierdzane
-- automatycznie i żadna odpowiedź nie jest zapisywana w tej tabeli.
create table if not exists public.myc_rel_questions (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  kind text not null check (kind in ('dom', 'młode', 'narzędzie', 'przeciwieństwo', 'część', 'produkt')),
  word text not null check (char_length(word) between 2 and 60 and word ~ '^[[:alpha:]]+( [[:alpha:]]+)*$'),
  question text not null check (char_length(question) between 5 and 200 and question ~ '\?$'),
  proposer text not null check (proposer in ('mówca', 'samouk')),
  reason text check (reason is null or char_length(reason) <= 300),
  voiced_msg bigint,
  voiced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (room, kind, word)
);
alter table public.myc_rel_questions enable row level security;
revoke all on public.myc_rel_questions from anon, authenticated;
grant select on public.myc_rel_questions to anon, authenticated;
-- wycofane pytanie (np. ze słowem z testu analogii) – nie jest pokazywane ani zadawane
alter table public.myc_rel_questions add column if not exists retired_at timestamptz;
alter table public.myc_rel_questions add column if not exists retired_why text;
drop policy if exists myc_rel_questions_read on public.myc_rel_questions;
create policy myc_rel_questions_read on public.myc_rel_questions for select using (true);

-- Treść pytania z rodzaju relacji i słowa w mianowniku (bez odmiany – nie zgadujemy form).
-- Te same szablony w web/src/myc/czystaRelacje.ts i src/iot_mycelium/mesh/relacje.py (pilnuje czysta-check).
create or replace function public.myc_rel_question_text(p_kind text, p_word text) returns text
language sql immutable as $$
  select case p_kind
    when 'dom' then 'Gdzie mieszka ' || p_word || '?'
    when 'młode' then 'Jak nazywa się młode zwierzęcia „' || p_word || '”?'
    when 'narzędzie' then 'Czego używa ' || p_word || ' w pracy?'
    when 'przeciwieństwo' then 'Co jest przeciwieństwem słowa „' || p_word || '”?'
    when 'część' then 'Czego częścią jest ' || p_word || '?'
    when 'produkt' then 'Co daje ' || p_word || '?'
  end
$$;

-- Propozycja pytania (tylko mówca w bazie i właścicielka przez Management API – brak uprawnień dla anon/authenticated).
-- Limity: 30 nowych pytań na proponującego na dobę, najwyżej 500 pytań w pokoju.
create or replace function public.myc_rel_propose(p_kind text, p_word text, p_proposer text, p_reason text default null,
  p_question text default null, p_room text default 'main') returns bigint
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare nid bigint; w text := lower(btrim(p_word));
begin
  if (select count(*) from myc_rel_questions where proposer = p_proposer and created_at > now() - interval '1 day') >= 30 then return null; end if;
  if (select count(*) from myc_rel_questions where room = p_room) >= 500 then return null; end if;
  -- słownictwo testów analogii nigdy nie trafia do pytań (supabase/myc_rel_banned.sql, wygenerowane z relacje.py)
  if myc_rel_has_banned(w) or myc_rel_has_banned(coalesce(p_question, '')) then return null; end if;
  insert into myc_rel_questions (room, kind, word, question, proposer, reason)
    values (p_room, p_kind, w, coalesce(p_question, myc_rel_question_text(p_kind, w)), p_proposer, left(p_reason, 300))
    on conflict (room, kind, word) do nothing returning id into nid;
  return nid;
end $$;
revoke execute on function public.myc_rel_propose(text, text, text, text, text, text) from public, anon, authenticated;

-- Mówca: (1) własna propozycja – z faktu-zdania „X mieszka w Y.” / „X używa Y.” / „X daje Y.”, który potwierdził
-- jeszcze ktoś poza autorem (≥ 2 różne węzły „tak”), pyta „Kto jeszcze mieszka w Y?” – to tylko pytanie;
-- (2) zadaje w czacie globalnym najstarsze niezadane pytanie, najwyżej jedno na 30 minut, gdy mówca jest włączony.
create or replace function public.myc_rel_speaker_tick() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s myc_speaker; f record; q myc_rel_questions; mid bigint; m text[]; k text;
begin
  select * into s from myc_speaker where id = 1;
  if s is null or not s.enabled then return jsonb_build_object('ok', false, 'why', 'speaker paused'); end if;
  for f in
    select u.text from myc_user_questions u
    where u.kind = 'fact' and u.text ~ '^[[:alpha:]]+ (mieszka|mieszkają|używa|używają|daje|dają) [[:alpha:]]+( [[:alpha:]]+)?\.?$'
      and (select count(distinct a.node_id) from myc_answers a where a.question_id = u.id and a.answer = 'tak') >= 2
    order by u.created_at desc limit 50
  loop
    m := regexp_match(f.text, '^[[:alpha:]]+ (mieszka|mieszkają|używa|używają|daje|dają) ([[:alpha:]]+( [[:alpha:]]+)?)\.?$');
    k := case when m[1] like 'mieszka%' then 'dom' when m[1] like 'używa%' then 'narzędzie' else 'produkt' end;
    if not exists (select 1 from myc_rel_questions where kind = k and word = lower(m[2])) and not myc_rel_has_banned(f.text) then
      perform myc_rel_propose(k, lower(m[2]), 'mówca', 'mówca: fakt-zdanie „' || f.text || '” potwierdzony przez co najmniej dwie osoby – pytam o kolejne przykłady tej relacji',
        'Kto jeszcze ' || case k when 'dom' then 'mieszka' when 'narzędzie' then 'używa' else 'daje' end || ' ' || lower(m[2]) || '?');
      exit;
    end if;
  end loop;
  if exists (select 1 from myc_rel_questions where voiced_at > now() - interval '30 minutes') then
    return jsonb_build_object('ok', false, 'why', 'interval');
  end if;
  select * into q from myc_rel_questions where voiced_msg is null and retired_at is null and room = 'main'
    and not myc_rel_has_banned(question) order by created_at, id limit 1;
  if q.id is null then return jsonb_build_object('ok', false, 'why', 'no questions'); end if;
  insert into myc_gchat (room, kind, handle, body, intent)
    values ('main', 'ai', 'Grzybnia AI', q.question || ' (pytanie o relację „' || q.kind || '”, zaproponował: ' || q.proposer
      || '. Odpowiedz pełnym zdaniem w zakładce „Czysta grzybnia” → „Naucz relacji”; zdanie trafi do Weryfikuj.)', 'pytanie')
    returning id into mid;
  update myc_rel_questions set voiced_msg = mid, voiced_at = now() where id = q.id;
  return jsonb_build_object('ok', true, 'msg', mid, 'question', q.id);
end $$;
revoke execute on function public.myc_rel_speaker_tick() from public, anon, authenticated;

do $$ begin
  perform cron.unschedule('myc_rel_speaker') where exists (select 1 from cron.job where jobname = 'myc_rel_speaker');
  perform cron.schedule('myc_rel_speaker', '*/10 * * * *', 'select public.myc_rel_speaker_tick()');
end $$;

-- wycofanie pytań ze słownictwem testu (także już zadanych w czacie: wpis mówcy oznaczony jako usunięty)
update myc_gchat g set deleted = true from myc_rel_questions q
  where q.voiced_msg = g.id and q.retired_at is null and myc_rel_has_banned(q.question);
update myc_rel_questions set retired_at = now(), retired_why = 'słowo z testu analogii'
  where retired_at is null and myc_rel_has_banned(question);
