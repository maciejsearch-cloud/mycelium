-- „Weryfikuj”: przegląd wyników przez właścicielkę (klucz właściciela – w bazie tylko skrót)
-- lub zaufanego współtwórcę (trafność na pytaniach kontrolnych ≥ 85% przy ≥ 30 odpowiedziach).
-- Każda decyzja = wiersz dziennika (kto, kiedy, przed → po), z możliwością cofnięcia.
-- Poprawki właścicielki są złotymi etykietami: wchodzą do wag zaufania (myc_gold_stats),
-- do danych treningowych (konsensus w przeglądarkach nadpisuje się etykietą) i do strzępków.

-- Klucze testowe pokoju e2e (tylko skróty; pokój 'e2e' nie dotyka prawdziwych danych).
create table if not exists public.myc_review_keys (key_hash text primary key, room text not null check (room in ('e2e')));
alter table public.myc_review_keys enable row level security;
revoke all on public.myc_review_keys from anon, authenticated;

create or replace function public.myc_key_room(p_key text) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select case
    when p_key is null or char_length(p_key) < 8 then null
    when exists (select 1 from myc_owner where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')) then 'main'
    else (select room from myc_review_keys where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')) end
$$;
revoke all on function public.myc_key_room(text) from public, anon, authenticated;

create table if not exists public.myc_reviews (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  item_type text not null check (item_type in ('answer', 'word', 'captcha', 'teach', 'chat', 'fragment', 'model', 'category', 'image', 'ocr')),
  item_ref text not null check (char_length(item_ref) between 1 and 80),
  kind text check (kind is null or kind ~ '^[a-z_]{1,16}$'),
  ai_answer text check (ai_answer is null or char_length(ai_answer) <= 300),
  ai_conf real check (ai_conf is null or ai_conf between 0 and 1),
  verdict text not null check (verdict in ('approve', 'reject', 'correct', 'skip')),
  truth text check (truth is null or char_length(truth) <= 300),
  ai_correct boolean,
  before jsonb not null default '{}' check (pg_column_size(before) < 8000),
  after jsonb not null default '{}' check (pg_column_size(after) < 8000),
  reviewer text not null check (reviewer in ('owner', 'contrib')),
  contributor_id uuid,
  node_id uuid,
  weight real not null check (weight between 0 and 1),
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_reason text check (undone_reason is null or undone_reason in ('undo', 'superseded'))
);
create index if not exists myc_reviews_item on public.myc_reviews (room, item_type, item_ref) where undone_at is null;
create index if not exists myc_reviews_time on public.myc_reviews (room, created_at desc);
alter table public.myc_reviews enable row level security;
revoke all on public.myc_reviews from anon, authenticated;
-- brak bezpośredniego odczytu (przed/po rozmów jest prywatne) – publicznie tylko etykiety i liczniki przez RPC

-- Prawo do przeglądu: 'owner' (klucz) albo 'contrib' (zaufany węzeł); zwraca (room, reviewer, weight).
create or replace function public.myc_reviewer(p_key text, p_node uuid, out room text, out reviewer text, out weight real)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n int; c int;
begin
  room := myc_key_room(p_key);
  if room is not null then reviewer := 'owner'; weight := 1; return; end if;
  select s.n, s.correct into n, c from myc_gold_stats() s where s.node_id = p_node;
  if coalesce(n, 0) >= 30 and c::real / n >= 0.85 then room := 'main'; reviewer := 'contrib'; weight := least(0.9, c::real / n); return; end if;
  room := null;
end $$;
revoke all on function public.myc_reviewer(text, uuid) from public, anon, authenticated;

-- Zapisz decyzję. p_item: {type, ref, kind, ai, conf, verdict, truth, frag:{subj,rel,obj,lang}}
create or replace function public.myc_review_submit(p_key text, p_node uuid, p_contrib uuid, p_item jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  who record; v text := p_item ->> 'verdict'; t text := p_item ->> 'type'; ref text := p_item ->> 'ref';
  tr text := nullif(btrim(coalesce(p_item ->> 'truth', '')), ''); ai text := p_item ->> 'ai';
  bef jsonb := '{}'; aft jsonb := '{}'; fr record; nid bigint; ch record; rid bigint; okc boolean; k text; frg jsonb := p_item -> 'frag';
begin
  select * into who from myc_reviewer(p_key, p_node);
  if who.room is null then raise exception 'myc: brak uprawnień do weryfikacji' using errcode = '42501'; end if;
  perform myc_rl('review:n:' || coalesce(p_node::text, 'x'), 90);
  if v not in ('approve', 'reject', 'correct', 'skip') then raise exception 'myc: verdict' using errcode = '22023'; end if;
  if v = 'correct' and tr is null then raise exception 'myc: brak poprawnej odpowiedzi' using errcode = '22023'; end if;
  if v = 'approve' then tr := coalesce(tr, ai); end if;
  okc := case v when 'approve' then true when 'skip' then null else false end;

  if t = 'chat' then
    if who.reviewer <> 'owner' or who.room <> 'main' then raise exception 'myc: rozmowy weryfikuje tylko właścicielka' using errcode = '42501'; end if;
    select id, feedback, user_text, reply into ch from myc_chats where id = (regexp_replace(ref, '^chat:', ''))::bigint;
    if ch.id is null then raise exception 'myc: brak rozmowy' using errcode = '22023'; end if;
    bef := jsonb_build_object('feedback', ch.feedback, 'reply', left(ch.reply, 1500));
    if v <> 'skip' then
      update myc_chats set feedback = case when v = 'approve' then 1 else -1 end where id = ch.id;
      aft := jsonb_build_object('feedback', case when v = 'approve' then 1 else -1 end, 'reply', left(tr, 1500));
    end if;
  elsif t = 'fragment' then
    select * into fr from myc_frags where id = ref::bigint and room = who.room;
    if fr.id is null then raise exception 'myc: brak strzępka' using errcode = '22023'; end if;
    ai := coalesce(ai, fr.obj);
    -- przed: stan tego strzępka i rodzeństwa w sprzeczności (ta sama encja i relacja)
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'trust', trust)), '[]') into bef
      from myc_frags where room = who.room and layer = fr.layer and lower(subj) = lower(fr.subj) and rel = fr.rel;
    bef := jsonb_build_object('frags', bef);
    if v = 'approve' then
      update myc_frags set status = 'verified', trust = greatest(trust, who.weight), updated_at = now() where id = fr.id;
      if myc_frag_functional(fr.rel) then
        update myc_frags set status = 'rejected', trust = 0, updated_at = now()
         where room = who.room and layer = fr.layer and lower(subj) = lower(fr.subj) and rel = fr.rel and id <> fr.id and lower(obj) <> lower(fr.obj);
      else
        update myc_frags set status = 'active', updated_at = now() where room = who.room and lower(subj) = lower(fr.subj) and rel = fr.rel and status = 'conflict';
      end if;
      tr := fr.obj;
    elsif v = 'reject' then
      update myc_frags set status = 'rejected', trust = 0, updated_at = now() where id = fr.id;
      update myc_frags set status = 'active', updated_at = now()
       where room = who.room and lower(subj) = lower(fr.subj) and rel = fr.rel and status = 'conflict'
         and (select count(distinct lower(obj)) from myc_frags o where o.room = who.room and lower(o.subj) = lower(fr.subj) and o.rel = fr.rel and o.status <> 'rejected') <= 1;
    elsif v = 'correct' then
      update myc_frags set status = 'rejected', trust = 0, updated_at = now()
       where room = who.room and layer = fr.layer and lower(subj) = lower(fr.subj) and rel = fr.rel and lower(obj) <> lower(tr) and (myc_frag_functional(fr.rel) or id = fr.id);
      k := myc_frag_key(fr.layer, fr.subj, fr.rel, tr);
      insert into myc_frags (room, layer, key, subj, rel, obj, lang, source, source_ref, trust, status, node_id)
      values (who.room, fr.layer, k, fr.subj, fr.rel, tr, fr.lang, 'owner', 'review', who.weight, 'verified', p_node)
      on conflict (room, key) do update set status = 'verified', trust = greatest(myc_frags.trust, excluded.trust), updated_at = now()
      returning id into nid;
      aft := jsonb_build_object('frag', nid);
    end if;
  elsif t in ('answer', 'word', 'captcha', 'teach', 'model', 'category', 'image', 'ocr') then
    -- etykieta jako strzępek (owner, zweryfikowany) – np. „wombat – jest – ssak”
    if v in ('approve', 'correct') and jsonb_typeof(frg) = 'object' and char_length(coalesce(frg ->> 'subj', '')) between 1 and 160
       and coalesce(frg ->> 'rel', '') ~ '^[a-z_]{2,24}$' then
      k := myc_frag_key(0, frg ->> 'subj', frg ->> 'rel', frg ->> 'obj');
      insert into myc_frags (room, layer, key, subj, rel, obj, lang, source, source_ref, trust, status, node_id)
      values (who.room, 0, k, btrim(frg ->> 'subj'), frg ->> 'rel', left(btrim(coalesce(frg ->> 'obj', '')), 300), coalesce(frg ->> 'lang', 'pl'), 'owner', left(t || ':' || ref, 200), who.weight, 'verified', p_node)
      on conflict (room, key) do update set status = 'verified', trust = greatest(myc_frags.trust, excluded.trust), updated_at = now()
      returning id into nid;
      -- poprawka unieważnia wcześniejszy strzępek z błędną odpowiedzią AI dla tego samego pytania
      if v = 'correct' and frg ? 'wrong_obj' then
        update myc_frags set status = 'rejected', trust = 0, updated_at = now()
         where room = who.room and layer = 0 and key = myc_frag_key(0, frg ->> 'subj', frg ->> 'rel', frg ->> 'wrong_obj') and source <> 'owner'
        returning jsonb_build_object('id', id, 'status', 'active', 'trust', trust) into bef;
        bef := jsonb_build_object('frags', jsonb_build_array(bef));
      end if;
      aft := jsonb_build_object('frag', nid);
    end if;
  else
    raise exception 'myc: item type' using errcode = '22023';
  end if;

  update myc_reviews set undone_at = now(), undone_reason = 'superseded'
   where room = who.room and item_type = t and item_ref = ref and undone_at is null;
  insert into myc_reviews (room, item_type, item_ref, kind, ai_answer, ai_conf, verdict, truth, ai_correct, before, after, reviewer, contributor_id, node_id, weight)
  values (who.room, t, ref, nullif(p_item ->> 'kind', ''), left(ai, 300), least(greatest((p_item ->> 'conf')::real, 0), 1), v, left(tr, 300), okc,
          coalesce(bef, '{}'), coalesce(aft, '{}'), who.reviewer, p_contrib, p_node, who.weight)
  returning id into rid;
  return jsonb_build_object('id', rid, 'room', who.room, 'reviewer', who.reviewer, 'weight', who.weight, 'frag', nid);
end $$;
revoke all on function public.myc_review_submit(text, uuid, uuid, jsonb) from public;
grant execute on function public.myc_review_submit(text, uuid, uuid, jsonb) to anon, authenticated;

-- Cofnij decyzję: przywraca stany strzępków i opinię rozmowy z kolumny „before”.
create or replace function public.myc_review_undo(p_key text, p_node uuid, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare who record; r record; f jsonb;
begin
  select * into who from myc_reviewer(p_key, p_node);
  if who.room is null then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  perform myc_rl('review:n:' || coalesce(p_node::text, 'x'), 90);
  select * into r from myc_reviews where id = p_id and room = who.room and undone_at is null;
  if r.id is null then raise exception 'myc: brak decyzji do cofnięcia' using errcode = '22023'; end if;
  if who.reviewer <> 'owner' and r.node_id is distinct from p_node then raise exception 'myc: cudza decyzja' using errcode = '42501'; end if;
  if r.item_type = 'chat' and r.before ? 'feedback' then
    update myc_chats set feedback = (r.before ->> 'feedback')::smallint where id = regexp_replace(r.item_ref, '^chat:', '')::bigint;
  end if;
  if r.after ? 'frag' and (r.after ->> 'frag') is not null then
    -- strzępek wstawiony tą decyzją: usuń, jeśli nikt inny go nie potwierdził
    delete from myc_frags where id = (r.after ->> 'frag')::bigint and source = 'owner' and source_ref in ('review', r.item_type || ':' || r.item_ref);
  end if;
  for f in select * from jsonb_array_elements(coalesce(r.before -> 'frags', '[]')) loop
    update myc_frags set status = f ->> 'status', trust = (f ->> 'trust')::real, updated_at = now() where id = (f ->> 'id')::bigint and room = who.room;
  end loop;
  update myc_reviews set undone_at = now(), undone_reason = 'undo' where id = r.id;
  return jsonb_build_object('undone', r.id);
end $$;
revoke all on function public.myc_review_undo(text, uuid, bigint) from public;
grant execute on function public.myc_review_undo(text, uuid, bigint) to anon, authenticated;

-- Publiczne etykiety (bez rozmów): przeglądarki nadpisują nimi konsensus → dane treningowe.
create or replace function public.myc_review_labels(p_room text default 'main')
returns table (id bigint, item_type text, item_ref text, verdict text, truth text, reviewer text, weight real, created_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, item_type, item_ref, verdict, truth, reviewer, weight, created_at from myc_reviews
  where room = p_room and undone_at is null and verdict <> 'skip' and item_type <> 'chat' order by id
$$;
-- Liczniki dzienne: ile przejrzano, ile razy AI miało rację (zatwierdzone) a ile było poprawiane.
create or replace function public.myc_review_stats(p_room text default 'main')
returns table (day date, item_type text, kind text, n int, ai_ok int, ai_wrong int, skipped int, owner int)
language sql stable security definer set search_path = public, pg_temp as $$
  select (created_at at time zone 'Europe/Amsterdam')::date, item_type, coalesce(kind, item_type), count(*)::int,
         count(*) filter (where ai_correct)::int, count(*) filter (where ai_correct = false)::int,
         count(*) filter (where verdict = 'skip')::int, count(*) filter (where reviewer = 'owner')::int
  from myc_reviews where room = p_room and (undone_at is null or undone_reason = 'superseded') group by 1, 2, 3 order by 1
$$;
revoke all on function public.myc_review_labels(text), public.myc_review_stats(text) from public;
grant execute on function public.myc_review_labels(text), public.myc_review_stats(text) to anon, authenticated;

-- Dziennik z „przed → po” i rozmowy do przeglądu – tylko z kluczem właściciela.
create or replace function public.myc_review_log(p_key text, p_limit int default 100)
returns table (id bigint, item_type text, item_ref text, kind text, ai_answer text, verdict text, truth text, before jsonb, after jsonb,
               reviewer text, created_at timestamptz, undone_at timestamptz, undone_reason text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rm text := myc_key_room(p_key);
begin
  if rm is null then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  return query select r.id, r.item_type, r.item_ref, r.kind, r.ai_answer, r.verdict, r.truth, r.before, r.after, r.reviewer, r.created_at, r.undone_at, r.undone_reason
    from myc_reviews r where r.room = rm order by r.id desc limit least(greatest(p_limit, 1), 500);
end $$;
create or replace function public.myc_review_chats(p_key text, p_limit int default 50)
returns table (id bigint, user_text text, reply text, act text, mode text, lang text, feedback smallint, created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if myc_key_room(p_key) is distinct from 'main' then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  return query select c.id, c.user_text, c.reply, c.act, c.mode, c.lang, c.feedback, c.created_at from myc_chats c
   where (c.feedback = -1 or c.act = 'unknown' or c.reply ~* '(nie jestem pewna|nie wiem|not sure|don''t know)')
     and not exists (select 1 from myc_reviews r where r.room = 'main' and r.item_type = 'chat' and r.item_ref = 'chat:' || c.id and r.undone_at is null)
   order by c.id desc limit least(greatest(p_limit, 1), 200);
end $$;
create or replace function public.myc_review_whoami(p_key text, p_node uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare w record;
begin
  select * into w from myc_reviewer(p_key, p_node);
  return jsonb_build_object('room', w.room, 'reviewer', w.reviewer, 'weight', w.weight);
end $$;
revoke all on function public.myc_review_log(text, int), public.myc_review_chats(text, int), public.myc_review_whoami(text, uuid) from public;
grant execute on function public.myc_review_log(text, int), public.myc_review_chats(text, int), public.myc_review_whoami(text, uuid) to anon, authenticated;

-- Wagi zaufania: złote etykiety = kontrolne pytania + decyzje właścicielki (tylko odpowiedzi sprzed decyzji,
-- żeby nie dało się „podejrzeć” etykiety i podbić sobie trafności).
create or replace function public.myc_gold_stats()
returns table (node_id uuid, n int, correct int)
language sql stable security definer set search_path = public, pg_temp as $$
  with g as (
    select question_id, answer, null::timestamptz at from myc_gold
    union all
    select r.item_ref, r.truth, r.created_at from myc_reviews r
     where r.room = 'main' and r.reviewer = 'owner' and r.undone_at is null and r.verdict in ('approve', 'correct')
       and r.item_type in ('answer', 'word', 'captcha', 'teach') and r.truth is not null
       and not exists (select 1 from myc_gold g2 where g2.question_id = r.item_ref)
  )
  select a.node_id, count(*)::int, count(*) filter (where a.answer = g.answer)::int
  from myc_answers a join g using (question_id)
  where g.at is null or a.created_at < g.at
  group by a.node_id
$$;
revoke all on function public.myc_gold_stats() from public;
grant execute on function public.myc_gold_stats() to anon, authenticated;

-- Sprzątanie pokoju testów (tylko kluczem testowym; nigdy nie dotyka pokoju 'main').
create or replace function public.myc_e2e_cleanup(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int; b int;
begin
  if myc_key_room(p_key) is distinct from 'e2e' then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  delete from myc_reviews where room = 'e2e'; get diagnostics a = row_count;
  delete from myc_frags where room = 'e2e'; get diagnostics b = row_count;
  return jsonb_build_object('reviews', a, 'frags', b);
end $$;
revoke all on function public.myc_e2e_cleanup(text) from public;
grant execute on function public.myc_e2e_cleanup(text) to anon, authenticated;
