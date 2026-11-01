-- Rozmówca czatu globalnego (01.11.2026, decyzja właścicielki): grzybnia rozumie wiadomości, odpowiada, wtrąca się,
-- pamięta czat i relacje z osobami, pilnuje zalewu. Logika (rozbiór, reguły, relacje, moderacja) jest w TypeScript
-- (web/src/myc/rozmowa) i działa w procesie rozmówcy (web/scripts/rozmowa-worker.mjs) – ten plik to tylko dane i
-- bezpieczne wejścia (RPC). Zapis wyłącznie kluczem rozmówcy (w bazie tylko skrót) albo z sesji konta (oceny).
-- BRAK CENZURY (warunek właścicielki): nic tu nie usuwa ani nie blokuje wiadomości za treść, poglądy czy wulgaryzmy.
-- Automatycznie tylko wyciszenie przy oczywistym zalewie; reszta to propozycje dla Developera (odwracalne, w dzienniku).
-- Zgoda na naukę (myc_account_prefs.train_ok = false): bez pamięci czatu, bez relacji, bez par dialogowych.

create table if not exists public.myc_rozmowa_cfg (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,
  interject_every_n int not null default 3 check (interject_every_n between 1 and 50), -- wtrącenie najwyżej co N wiadomości ludzi
  interject_min_s int not null default 90 check (interject_min_s between 10 and 3600),  -- i nie częściej niż co tyle sekund
  invite_quiet_min int not null default 45 check (invite_quiet_min between 5 and 1440), -- zaproszenie po tylu min ciszy
  invite_every_min int not null default 180 check (invite_every_min between 10 and 2880),
  mute_flood_min int not null default 10 check (mute_flood_min between 1 and 60),
  worker_key_hash text,
  worker_version text,
  heartbeat_at timestamptz,
  cursor bigint not null default 0,
  last_invite_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.myc_rozmowa_cfg (id, cursor) values (1, coalesce((select max(id) from public.myc_gchat), 0)) on conflict do nothing;

-- Pamięć czatu: zwięzły rozbiór każdej wiadomości osoby ze zgodą (tokeny ≤ 30 dni, potem same cechy; po 180 dniach
-- wiersz znika, zostaje podsumowanie dnia). Tekst i tak jest w myc_gchat; tu lematy treści do wyszukiwania.
create table if not exists public.myc_chat_mem (
  msg_id bigint primary key references public.myc_gchat (id) on delete cascade,
  account_id uuid references public.myc_accounts (id) on delete cascade,
  handle text not null,
  at timestamptz not null,
  content text[] not null default '{}' check (cardinality(content) <= 12),
  acts text[] not null default '{}' check (cardinality(acts) <= 12),
  parse jsonb not null check (pg_column_size(parse) < 6000)
);
create index if not exists myc_chat_mem_at on public.myc_chat_mem (at desc);
create index if not exists myc_chat_mem_handle on public.myc_chat_mem (lower(handle), at desc);
create index if not exists myc_chat_mem_content on public.myc_chat_mem using gin (content);
-- Podsumowanie dnia na osobę: liczba wiadomości, najczęstsze lematy, akty mowy (wiedza zostaje po GC surowych wierszy).
create table if not exists public.myc_chat_mem_day (
  day date not null,
  handle text not null,
  n int not null default 0,
  lemmas jsonb not null default '{}' check (pg_column_size(lemmas) < 4000),
  acts jsonb not null default '{}' check (pg_column_size(acts) < 1000),
  primary key (day, handle)
);

-- Relacje grzybni z osobami (część „relacje” SelfModelu). Zapis tylko rozmówca; odczyt: osoba o sobie + Developer.
create table if not exists public.myc_self_relations (
  account_id uuid primary key references public.myc_accounts (id) on delete cascade,
  state jsonb not null check (pg_column_size(state) < 4000),
  score real not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.myc_self_rel_events (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.myc_accounts (id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (kind in ('obraza', 'przeprosiny', 'komplement', 'wrogość_wobec_innych')),
  msg_id bigint,
  excerpt text check (excerpt is null or char_length(excerpt) <= 120)
);
create index if not exists myc_self_rel_events_acc on public.myc_self_rel_events (account_id, at desc);

-- Odpowiedzi grzybni: źródło (reguła / ludzie / pamięć / fakt / model), reguła, cytat, opóźnienie.
create table if not exists public.myc_rozmowa_replies (
  msg_id bigint primary key references public.myc_gchat (id) on delete cascade,
  to_msg bigint,
  source text not null check (source in ('reguła', 'model', 'fakt', 'ludzie', 'pamięć')),
  rule text not null check (rule ~ '^[a-z_ąćęłńóśźż.]{2,40}$'),
  cite text check (cite is null or char_length(cite) <= 200),
  addressed boolean not null,
  latency_ms int,
  at timestamptz not null default now()
);
create index if not exists myc_rozmowa_replies_to on public.myc_rozmowa_replies (to_msg);
-- Oceny odpowiedzi (👍/👎 i „popraw”) – skrót konta, bez IP.
create table if not exists public.myc_rozmowa_votes (
  msg_id bigint not null references public.myc_gchat (id) on delete cascade,
  voter text not null,
  train_ok boolean not null,
  dev boolean not null default false,
  sense smallint check (sense in (-1, 1)),
  fixed text check (fixed is null or char_length(fixed) between 1 and 300),
  at timestamptz not null default now(),
  primary key (msg_id, voter)
);
-- Pary dialogowe zatwierdzone przez ludzi: ≥ 2 osoby ze zgodą z tą samą poprawką albo poprawka Developera.
create table if not exists public.myc_rozmowa_pairs (
  id bigint generated always as identity primary key,
  prompt_key text not null check (char_length(prompt_key) between 1 and 300),
  prompt text not null check (char_length(prompt) between 1 and 1000),
  reply text not null check (char_length(reply) between 1 and 300),
  n_agree int not null,
  by_dev boolean not null default false,
  at timestamptz not null default now(),
  unique (prompt_key)
);
-- Decyzje rozmówcy (moderacja) – historia decyzji SelfModelu z wynikiem (zastosowana / czeka / przyjęta / odrzucona / cofnięta).
create table if not exists public.myc_rozmowa_decisions (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('mute_auto', 'propose', 'warn')),
  account_id uuid references public.myc_accounts (id) on delete set null,
  handle text,
  target text check (target is null or char_length(target) <= 40),
  minutes int,
  reason text not null check (char_length(reason) <= 300),
  evidence bigint[] not null default '{}',
  status text not null check (status in ('applied', 'pending', 'accepted', 'rejected', 'reverted', 'skipped')),
  decided_by uuid references public.myc_accounts (id) on delete set null,
  decided_at timestamptz,
  note text check (note is null or char_length(note) <= 200)
);
create index if not exists myc_rozmowa_decisions_st on public.myc_rozmowa_decisions (status, at desc);
-- Weryfikuj: ukrycie pozycji kolejki przez Developera (miękkie, z dziennikiem, do przywrócenia).
create table if not exists public.myc_review_hidden (
  room text not null default 'main' check (room in ('main', 'e2e')),
  item_type text not null check (item_type ~ '^[a-z_]{2,16}$'),
  item_ref text not null check (char_length(item_ref) between 1 and 120),
  reason text not null check (char_length(reason) between 1 and 200),
  hidden_by text not null check (char_length(hidden_by) <= 40),
  hidden_at timestamptz not null default now(),
  restored_at timestamptz,
  restored_by text,
  primary key (room, item_type, item_ref)
);

alter table public.myc_rozmowa_cfg enable row level security;
alter table public.myc_chat_mem enable row level security;
alter table public.myc_chat_mem_day enable row level security;
alter table public.myc_self_relations enable row level security;
alter table public.myc_self_rel_events enable row level security;
alter table public.myc_rozmowa_replies enable row level security;
alter table public.myc_rozmowa_votes enable row level security;
alter table public.myc_rozmowa_pairs enable row level security;
alter table public.myc_rozmowa_decisions enable row level security;
alter table public.myc_review_hidden enable row level security;
revoke all on public.myc_rozmowa_cfg, public.myc_chat_mem, public.myc_chat_mem_day, public.myc_self_relations, public.myc_self_rel_events,
  public.myc_rozmowa_replies, public.myc_rozmowa_votes, public.myc_rozmowa_pairs, public.myc_rozmowa_decisions, public.myc_review_hidden
  from public, anon, authenticated;
-- publicznie: źródło odpowiedzi (plakietka w czacie) i zatwierdzone pary (dane do nauki, jak myc_speaker_sft)
grant select on public.myc_rozmowa_replies, public.myc_rozmowa_pairs to anon, authenticated;
drop policy if exists myc_rozmowa_replies_read on public.myc_rozmowa_replies;
create policy myc_rozmowa_replies_read on public.myc_rozmowa_replies for select using (true);
drop policy if exists myc_rozmowa_pairs_read on public.myc_rozmowa_pairs;
create policy myc_rozmowa_pairs_read on public.myc_rozmowa_pairs for select using (true);

-- klucz rozmówcy (w bazie tylko skrót sha256)
create or replace function public.myc_rozmowa_key_ok(p_key text) returns boolean
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select p_key is not null and char_length(p_key) >= 32
     and exists (select 1 from myc_rozmowa_cfg where id = 1 and worker_key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex'))
$$;
revoke all on function public.myc_rozmowa_key_ok(text) from public, anon, authenticated;

create or replace function public.myc_rozmowa_dev(p_key text default null) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  -- Developer: konto z rolą developer (czat) albo klucz właściciela; zwraca etykietę do dziennika
  select case
    when myc_acct_id() is not null and myc_role_of(myc_acct_id()) = 'developer' then 'dev:' || coalesce((select handle from myc_accounts where id = myc_acct_id()), '?')
    when p_key is not null and char_length(p_key) >= 8 and exists (select 1 from myc_owner where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')) then 'owner_key'
  end
$$;
revoke all on function public.myc_rozmowa_dev(text) from public, anon, authenticated;

-- fakty o grzybni z bazy (prawdziwe liczby do odpowiedzi „o sobie”)
alter table public.myc_rozmowa_cfg add column if not exists self_cache jsonb, add column if not exists self_at timestamptz;
create or replace function public.myc_rozmowa_self() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'nodes_online', (select count(distinct node_id) from myc_results where created_at > now() - interval '15 minutes'),
    'lm_version', (select 'v' || max(version) from myc_models where model = 'lm'),
    'first_seen', (select min(created_at) from myc_results),
    'chat_msgs_learned', (select count(*) from myc_chat_mem) + coalesce((select sum(n) from myc_chat_mem_day d where d.day < (select coalesce(min(at)::date, current_date) from myc_chat_mem)), 0),
    'relations', (select count(*) from myc_self_relations),
    'learning', (select string_agg(k || ' (' || v || ')', ', ' order by v::int desc, k) from myc_lm_curriculum c, jsonb_each_text(c.alloc) e(k, v)
                 where c.id = (select max(id) from myc_lm_curriculum))))
$$;
revoke all on function public.myc_rozmowa_self() from public, anon, authenticated;

-- Rozmówca: nowe wiadomości ludzi (kanał globalny, pokój main) + kontekst. Uaktualnia „bicie serca”.
create or replace function public.myc_rozmowa_pending(p_key text, p_version text default null, p_limit int default 20) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c myc_rozmowa_cfg; r jsonb;
begin
  if not myc_rozmowa_key_ok(p_key) then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  update myc_rozmowa_cfg set heartbeat_at = now(), worker_version = left(coalesce(p_version, worker_version), 40) where id = 1 returning * into c;
  -- fakty o sobie liczone najwyżej co 5 min (skan myc_results nie przy każdym odpytaniu co 2 s)
  if c.self_at is null or c.self_at < now() - interval '5 minutes' then
    update myc_rozmowa_cfg set self_cache = myc_rozmowa_self(), self_at = now() where id = 1 returning * into c;
  end if;
  select jsonb_build_object(
    'cfg', jsonb_build_object('enabled', c.enabled, 'interject_every_n', c.interject_every_n, 'interject_min_s', c.interject_min_s,
       'invite_quiet_min', c.invite_quiet_min, 'invite_every_min', c.invite_every_min, 'mute_flood_min', c.mute_flood_min, 'cursor', c.cursor,
       'last_invite_at', c.last_invite_at),
    'msgs', coalesce((select jsonb_agg(x order by (x->>'id')::bigint) from (
      select jsonb_build_object('id', m.id, 'handle', m.handle, 'body', m.body, 'at', m.created_at, 'reply_to', m.reply_to,
        'reply_to_ai', exists (select 1 from myc_gchat q where q.id = m.reply_to and q.kind = 'ai'),
        'author', md5('myc-rozmowa-v1' || coalesce(p.account_id::text, m.handle)),
        'train_ok', coalesce(p.train_ok, false) and coalesce((select train_ok from myc_account_prefs f where f.account_id = p.account_id), true),
        'role', m.role,
        'rel', case when coalesce((select train_ok from myc_account_prefs f where f.account_id = p.account_id), true) then (select state from myc_self_relations s where s.account_id = p.account_id) end) x
      from myc_gchat m left join myc_gchat_priv p on p.msg_id = m.id
      where m.id > c.cursor and m.room = 'main' and m.circle_id is null and m.kind = 'user' and not m.deleted
      order by m.id limit least(greatest(coalesce(p_limit, 20), 1), 50)) z), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'handle', handle, 'body', left(body, 200), 'at', created_at) order by id)
       from (select * from myc_gchat where room = 'main' and circle_id is null and not deleted order by id desc limit 40) t), '[]'::jsonb),
    'last_user_at', (select max(created_at) from myc_gchat where room = 'main' and circle_id is null and kind = 'user'),
    'self', c.self_cache,
    'pairs', coalesce((select jsonb_object_agg(prompt_key, reply) from (select prompt_key, reply from myc_rozmowa_pairs order by id desc limit 2000) p), '{}'::jsonb))
  into r;
  return r;
end $$;

-- Pamięć czatu: wyszukiwanie po pseudonimie i/lub lematach (tylko wiadomości osób ze zgodą)
create or replace function public.myc_rozmowa_recall(p_key text, p_handle text default null, p_lemmas text[] default null, p_before bigint default null, p_limit int default 3)
returns table (handle text, at timestamptz, text text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not myc_rozmowa_key_ok(p_key) then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  return query select m.handle, m.at, g.body from myc_chat_mem m join myc_gchat g on g.id = m.msg_id
   where not g.deleted and (p_before is null or m.msg_id < p_before)
     and not ('przypomnienie' = any (m.acts)) -- pytania „kto co pisał” nie są odpowiedzią na nie same
     and (p_handle is null or lower(m.handle) = lower(p_handle))
     and (p_lemmas is null or cardinality(p_lemmas) = 0 or m.content && p_lemmas
          -- wspólny początek lematu (≥ 3 litery, długość − 2): „nuda” znajduje „nudzić”
          or exists (select 1 from unnest(m.content) c, unnest(p_lemmas) q
                      where char_length(q) >= 4 and left(c, greatest(3, char_length(q) - 2)) = left(q, greatest(3, char_length(q) - 2))))
     and (p_handle is not null or (p_lemmas is not null and cardinality(p_lemmas) > 0))
   order by m.msg_id desc limit least(greatest(coalesce(p_limit, 3), 1), 10);
end $$;

-- wpis grzybni do czatu (wewnętrzne)
create or replace function public.myc_rozmowa_say(p_body text, p_reply_to bigint, p_reply jsonb, p_latency int) returns bigint
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare id_ bigint; b text := left(btrim(coalesce(p_body, '')), 1000);
begin
  if char_length(b) = 0 then return null; end if;
  insert into myc_gchat (room, kind, handle, body, reply_to) values ('main', 'ai', 'Grzybnia AI', b, p_reply_to) returning id into id_;
  insert into myc_gchat_priv (msg_id, train_ok, body_hash) values (id_, false, encode(extensions.digest(b, 'sha256'), 'hex'));
  insert into myc_rozmowa_replies (msg_id, to_msg, source, rule, cite, addressed, latency_ms)
    values (id_, p_reply_to, coalesce(p_reply->>'source', 'reguła'), coalesce(p_reply->>'rule', 'inne'), left(p_reply->>'cite', 200),
            coalesce((p_reply->>'addressed')::boolean, false), p_latency);
  return id_;
end $$;
revoke all on function public.myc_rozmowa_say(text, bigint, jsonb, int) from public, anon, authenticated;

-- Rozmówca: wynik dla jednej wiadomości. p_parse: zwięzły rozbiór; p_rel: nowy stan relacji (relations.ts) i zdarzenia;
-- p_reply: {text, source, rule, cite, addressed}; p_mod: [{kind, author, minutes, reason, evidence, target, text}].
create or replace function public.myc_rozmowa_submit(p_key text, p_msg bigint, p_parse jsonb, p_rel jsonb default null, p_events text[] default '{}',
  p_reply jsonb default null, p_mod jsonb default '[]') returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c myc_rozmowa_cfg; m myc_gchat; acc uuid; ok boolean; out jsonb := '{}'; rid bigint; addr boolean; last_int timestamptz; n_since int;
  a jsonb; tgt uuid; d text := (now() at time zone 'Europe/Amsterdam')::date::text; e text; lat int;
begin
  if not myc_rozmowa_key_ok(p_key) then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  select * into c from myc_rozmowa_cfg where id = 1 for update;
  select * into m from myc_gchat where id = p_msg and room = 'main' and circle_id is null and kind = 'user';
  if m.id is null then
    update myc_rozmowa_cfg set cursor = greatest(cursor, coalesce(p_msg, 0)) where id = 1;
    return jsonb_build_object('skipped', 'brak wiadomości');
  end if;
  select p.account_id, p.train_ok and coalesce(f.train_ok, true) into acc, ok
    from myc_gchat_priv p left join myc_account_prefs f on f.account_id = p.account_id where p.msg_id = m.id;
  ok := coalesce(ok, false);
  -- (1) pamięć czatu i podsumowanie dnia – tylko za zgodą
  if ok and p_parse is not null and pg_column_size(p_parse) < 6000 then
    insert into myc_chat_mem (msg_id, account_id, handle, at, content, acts, parse)
      values (m.id, acc, m.handle, m.created_at,
        coalesce((select array_agg(x) from (select jsonb_array_elements_text(p_parse->'content') x limit 12) z), '{}'),
        coalesce((select array_agg(x) from (select jsonb_array_elements_text(p_parse->'acts') x limit 12) z), '{}'), p_parse)
      on conflict (msg_id) do nothing;
    insert into myc_chat_mem_day as t (day, handle, n, lemmas, acts) values ((m.created_at at time zone 'Europe/Amsterdam')::date, m.handle, 1,
        coalesce((select jsonb_object_agg(x, 1) from (select distinct jsonb_array_elements_text(p_parse->'content') x limit 12) z), '{}'),
        coalesce((select jsonb_object_agg(x, 1) from (select distinct jsonb_array_elements_text(p_parse->'acts') x) z), '{}'))
      on conflict (day, handle) do update set n = t.n + 1,
        lemmas = (select coalesce(jsonb_object_agg(k, v), '{}') from (select k, sum(v::int) v from (select * from jsonb_each_text(t.lemmas) union all select * from jsonb_each_text(excluded.lemmas)) u(k, v) group by k order by sum(v::int) desc limit 40) w),
        acts = (select coalesce(jsonb_object_agg(k, v), '{}') from (select k, sum(v::int) v from (select * from jsonb_each_text(t.acts) union all select * from jsonb_each_text(excluded.acts)) u(k, v) group by k) w);
  end if;
  -- (2) relacja – tylko za zgodą
  if ok and acc is not null and p_rel is not null and pg_column_size(p_rel) < 4000 then
    insert into myc_self_relations (account_id, state, score) values (acc, p_rel, coalesce((p_rel->>'score')::real, 0))
      on conflict (account_id) do update set state = excluded.state, score = excluded.score, updated_at = now();
    foreach e in array coalesce(p_events, '{}') loop
      if e in ('obraza', 'przeprosiny', 'komplement', 'wrogość_wobec_innych') then
        insert into myc_self_rel_events (account_id, kind, msg_id, excerpt) values (acc, e, m.id, left(m.body, 120));
      end if;
    end loop;
  end if;
  -- (3) moderacja: zalew → automatyczne wyciszenie (nie wobec Developera/Moderatora); reszta = propozycja
  for a in select * from jsonb_array_elements(coalesce(p_mod, '[]')) loop
    if a->>'kind' = 'mute_auto' and acc is not null then
      if myc_role_of(acc) is null and not exists (select 1 from myc_rozmowa_decisions where account_id = acc and kind = 'mute_auto' and at > now() - interval '10 minutes') then
        insert into myc_gchat_sanctions (account_id, muted_until, reason, by_account) values (acc, now() + make_interval(mins => least(coalesce((a->>'minutes')::int, c.mute_flood_min), 60)), left('grzybnia: ' || (a->>'reason'), 200), null)
          on conflict (account_id) do update set muted_until = greatest(myc_gchat_sanctions.muted_until, excluded.muted_until), reason = excluded.reason, at = now();
        insert into myc_mod_log (room, actor_role, action, msg_id, target, detail) values ('main', 'system', 'mute_auto', m.id, acc, jsonb_build_object('minutes', a->'minutes', 'reason', a->>'reason', 'by', 'grzybnia'));
        insert into myc_rozmowa_decisions (kind, account_id, handle, minutes, reason, evidence, status)
          values ('mute_auto', acc, m.handle, (a->>'minutes')::int, left(a->>'reason', 300), coalesce((select array_agg(x::bigint) from jsonb_array_elements_text(a->'evidence') x), '{}'), 'applied');
        out := out || jsonb_build_object('muted', true);
      end if;
    elsif a->>'kind' = 'propose' and acc is not null then
      if not exists (select 1 from myc_rozmowa_decisions where account_id = acc and kind = 'propose' and status = 'pending' and target is not distinct from left(a->>'target', 40)) then
        insert into myc_rozmowa_decisions (kind, account_id, handle, target, minutes, reason, evidence, status)
          values ('propose', acc, m.handle, left(a->>'target', 40), least(coalesce((a->>'minutes')::int, 60), 1440), left(a->>'reason', 300),
                  coalesce((select array_agg(x::bigint) from jsonb_array_elements_text(a->'evidence') x), '{}'), 'pending');
        insert into myc_mod_log (room, actor_role, action, msg_id, target, detail) values ('main', 'system', 'mod_proposal', m.id, acc, jsonb_build_object('reason', a->>'reason', 'by', 'grzybnia'));
        out := out || jsonb_build_object('proposed', true);
      end if;
    elsif a->>'kind' = 'warn' then
      if not exists (select 1 from myc_rozmowa_decisions where handle = m.handle and kind = 'warn' and at > now() - interval '10 minutes') then
        insert into myc_rozmowa_decisions (kind, account_id, handle, reason, evidence, status) values ('warn', acc, m.handle, left(a->>'text', 300), array[m.id], 'applied');
        perform myc_rozmowa_say(a->>'text', m.id, jsonb_build_object('source', 'reguła', 'rule', 'moderacja.ostrzezenie', 'addressed', false), null);
      end if;
    end if;
  end loop;
  -- (4) odpowiedź; wtrącenia (addressed = false) z limitem: co N wiadomości ludzi i nie częściej niż co X s
  if c.enabled and p_reply is not null and coalesce(p_reply->>'text', '') <> '' then
    addr := coalesce((p_reply->>'addressed')::boolean, false);
    if not addr then
      select max(r.at) into last_int from myc_rozmowa_replies r where not r.addressed and r.rule <> 'moderacja.ostrzezenie';
      select count(*) into n_since from myc_gchat g where g.room = 'main' and g.circle_id is null and g.kind = 'user' and g.id <= m.id
        and g.created_at > coalesce(last_int, '-infinity'::timestamptz);
    end if;
    if addr or ((last_int is null or now() - last_int >= make_interval(secs => c.interject_min_s)) and coalesce(n_since, 0) >= case when last_int is null then 1 else c.interject_every_n end) then
      lat := (extract(epoch from (clock_timestamp() - m.created_at)) * 1000)::int;
      rid := myc_rozmowa_say(p_reply->>'text', m.id, p_reply, lat);
      out := out || jsonb_build_object('reply', rid, 'latency_ms', lat);
    else
      out := out || jsonb_build_object('reply', null, 'why', 'limit wtrąceń');
    end if;
  end if;
  update myc_rozmowa_cfg set cursor = greatest(cursor, m.id) where id = 1;
  return out;
end $$;

-- Zaproszenie do rozmowy, gdy cicho (rozmówca sprawdza warunki w cfg; baza pilnuje ich jeszcze raz)
create or replace function public.myc_rozmowa_invite(p_key text, p_reply jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c myc_rozmowa_cfg; lu timestamptz; rid bigint;
begin
  if not myc_rozmowa_key_ok(p_key) then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  select * into c from myc_rozmowa_cfg where id = 1 for update;
  if not c.enabled then return jsonb_build_object('ok', false, 'why', 'wstrzymany'); end if;
  select max(created_at) into lu from myc_gchat where room = 'main' and circle_id is null and kind = 'user';
  if lu is not null and now() - lu < make_interval(mins => c.invite_quiet_min) then return jsonb_build_object('ok', false, 'why', 'rozmowa trwa'); end if;
  if c.last_invite_at is not null and now() - c.last_invite_at < make_interval(mins => c.invite_every_min) then return jsonb_build_object('ok', false, 'why', 'za wcześnie'); end if;
  rid := myc_rozmowa_say(p_reply->>'text', null, p_reply || jsonb_build_object('addressed', false), null);
  update myc_rozmowa_cfg set last_invite_at = now() where id = 1;
  return jsonb_build_object('ok', true, 'id', rid);
end $$;

-- Ocena odpowiedzi grzybni (konto z sesji): 👍/👎 i poprawka. Konsensus: ≥ 2 osoby ze zgodą z tą samą poprawką
-- (≥ 2/3 poprawek) albo poprawka Developera → para dialogowa (wiadomość osoby → poprawiona odpowiedź).
create or replace function public.myc_rozmowa_rate(p_msg bigint, p_sense smallint default null, p_fixed text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); ok boolean; vh text; rr myc_rozmowa_replies; um myc_gchat; fx text := left(nullif(btrim(coalesce(p_fixed, '')), ''), 300);
  isdev boolean; n_tot int; n_top int; top text; uok boolean;
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: załóż konto, żeby oceniać' using errcode = '42501'; end if;
  perform myc_rl('rozmowa_rate:' || acc, 30);
  select * into rr from myc_rozmowa_replies where msg_id = p_msg;
  if rr.msg_id is null then raise exception 'myc: to nie jest odpowiedź rozmówcy' using errcode = '22023'; end if;
  ok := coalesce((select train_ok from myc_account_prefs where account_id = acc), true);
  isdev := myc_role_of(acc) = 'developer';
  vh := md5('myc-rozmowa-v1' || acc::text);
  insert into myc_rozmowa_votes as v (msg_id, voter, train_ok, dev, sense, fixed) values (p_msg, vh, ok, isdev, p_sense, fx)
    on conflict (msg_id, voter) do update set train_ok = ok, dev = isdev, sense = coalesce(excluded.sense, v.sense), fixed = coalesce(excluded.fixed, v.fixed), at = now();
  select * into um from myc_gchat where id = rr.to_msg and not deleted;
  select coalesce(p.train_ok, false) into uok from myc_gchat_priv p where p.msg_id = um.id;
  if um.id is not null and uok and fx is not null then
    select sum(c), max(c) into n_tot, n_top from (select count(*) c from myc_rozmowa_votes where msg_id = p_msg and train_ok and fixed is not null group by lower(btrim(fixed))) z;
    select f into top from (select lower(btrim(fixed)) f, count(*) c from myc_rozmowa_votes where msg_id = p_msg and train_ok and fixed is not null group by 1 order by 2 desc limit 1) z;
    if isdev or (n_top >= 2 and n_top * 3 >= n_tot * 2) then
      insert into myc_rozmowa_pairs (prompt_key, prompt, reply, n_agree, by_dev)
        values (left(lower(regexp_replace(regexp_replace(regexp_replace(um.body, 'grzybni[oa]', ' ', 'gi'), '[^[:alnum:] ]+', ' ', 'g'), '\s+', ' ', 'g')), 300),
                um.body, case when isdev then fx else top end, coalesce(n_top, 1), isdev)
        on conflict (prompt_key) do update set reply = excluded.reply, n_agree = excluded.n_agree, by_dev = excluded.by_dev, at = now();
    end if;
  end if;
  return jsonb_build_object('ok', true, 'train_ok', ok);
end $$;

-- Dla interfejsu: źródło i oceny odpowiedzi grzybni + rozbiór wiadomości ludzi (gdy zapisany za zgodą)
create or replace function public.myc_rozmowa_meta(p_ids bigint[]) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'replies', coalesce((select jsonb_object_agg(r.msg_id, jsonb_build_object('source', r.source, 'rule', r.rule, 'cite', r.cite, 'to', r.to_msg,
        'addressed', r.addressed, 'latency_ms', r.latency_ms,
        'up', (select count(*) from myc_rozmowa_votes v where v.msg_id = r.msg_id and v.sense = 1),
        'down', (select count(*) from myc_rozmowa_votes v where v.msg_id = r.msg_id and v.sense = -1),
        'mine', (select jsonb_build_object('sense', v.sense, 'fixed', v.fixed) from myc_rozmowa_votes v where v.msg_id = r.msg_id and myc_acct_id() is not null and v.voter = md5('myc-rozmowa-v1' || myc_acct_id()::text))))
      from myc_rozmowa_replies r where r.msg_id = any (p_ids[1:200])), '{}'::jsonb),
    'parsed', coalesce((select jsonb_agg(m.msg_id) from myc_chat_mem m where m.msg_id = any (p_ids[1:200])), '[]'::jsonb))
$$;
create or replace function public.myc_rozmowa_parse(p_msg bigint) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select parse from myc_chat_mem where msg_id = p_msg
$$;
create or replace function public.myc_rozmowa_state() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('enabled', c.enabled, 'heartbeat_at', c.heartbeat_at, 'online', c.heartbeat_at > now() - interval '30 seconds',
    'worker_version', c.worker_version, 'interject_every_n', c.interject_every_n, 'interject_min_s', c.interject_min_s,
    'invite_quiet_min', c.invite_quiet_min, 'replies', (select count(*) from myc_rozmowa_replies),
    'median_latency_ms', (select percentile_cont(0.5) within group (order by latency_ms) from (select latency_ms from myc_rozmowa_replies where latency_ms is not null and addressed order by msg_id desc limit 50) z),
    'mem', (select count(*) from myc_chat_mem), 'pairs', (select count(*) from myc_rozmowa_pairs),
    'pending_decisions', (select count(*) from myc_rozmowa_decisions where status = 'pending'))
  from myc_rozmowa_cfg c where c.id = 1
$$;

-- Moja relacja z grzybnią (osoba o sobie; Developer może podać pseudonim)
create or replace function public.myc_self_relation_me(p_handle text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); who uuid;
begin
  if acc is null then return null; end if;
  who := acc;
  if p_handle is not null then
    if myc_role_of(acc) is distinct from 'developer' then raise exception 'myc: tylko Developer' using errcode = '42501'; end if;
    select id into who from myc_accounts where room = 'main' and lower(handle) = lower(btrim(p_handle));
  end if;
  return jsonb_build_object('train_ok', coalesce((select train_ok from myc_account_prefs where account_id = who), true),
    'state', (select state from myc_self_relations where account_id = who),
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'kind', kind, 'msg_id', msg_id, 'excerpt', excerpt) order by at desc)
       from (select * from myc_self_rel_events where account_id = who order by at desc limit 20) e), '[]'::jsonb));
end $$;
-- Zapomnij mnie: usuwa relację i pamięć czatu konta (osoba sama)
create or replace function public.myc_self_relation_forget() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); a int; b int;
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: brak konta' using errcode = '42501'; end if;
  delete from myc_self_relations where account_id = acc;
  delete from myc_self_rel_events where account_id = acc; get diagnostics a = row_count;
  delete from myc_speaker_chatq q using myc_gchat_priv p where p.msg_id = q.msg_id and p.account_id = acc;
  delete from myc_chat_mem where account_id = acc; get diagnostics b = row_count;
  return jsonb_build_object('ok', true, 'events', a, 'mem', b);
end $$;

-- Interfejs dla SelfModelu (publiczny, bez danych osobowych): stan źródła i historia decyzji rozmówcy
create or replace function public.myc_self_relations_status() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('source', 'myc_self_relations', 'available', true, 'rows', (select count(*) from myc_self_relations),
    'opted_out_excluded', true, 'decisions', (select count(*) from myc_rozmowa_decisions),
    'tone', jsonb_build_object('ciepło', (select count(*) from myc_self_relations where score >= 2), 'chłodno', (select count(*) from myc_self_relations where score <= -2)))
$$;
create or replace function public.myc_self_rel_decisions(p_limit int default 50) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', 'rozmowa-' || id, 'at', at, 'kind', 'moderacja-' || kind,
      'choice', jsonb_strip_nulls(jsonb_build_object('minutes', minutes, 'evidence', cardinality(evidence))), 'reason', reason,
      'outcome', jsonb_build_object('status', status, 'decided_at', decided_at),
      'outcome_pl', case status when 'applied' then 'zastosowana automatycznie' when 'pending' then 'czeka na decyzję Developera'
        when 'accepted' then 'przyjęta przez Developera' when 'rejected' then 'odrzucona przez Developera' when 'reverted' then 'cofnięta przez Developera' else status end)
      order by at desc), '[]'::jsonb)
  from (select * from myc_rozmowa_decisions order by at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) d
$$;

-- Developer: lista decyzji (z pseudonimami) i decyzja w sprawie propozycji / cofnięcie automatycznego wyciszenia
create or replace function public.myc_rozmowa_decisions_list(p_status text default null, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if myc_role_of(myc_acct_id()) is null then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'at', d.at, 'kind', d.kind, 'handle', d.handle, 'target', d.target, 'minutes', d.minutes,
      'reason', d.reason, 'evidence', d.evidence, 'status', d.status, 'decided_at', d.decided_at, 'decided_by', a.handle, 'note', d.note,
      'texts', (select jsonb_agg(jsonb_build_object('id', g.id, 'body', g.body, 'at', g.created_at) order by g.id) from myc_gchat g where g.id = any (d.evidence)))
      order by d.at desc)
    from (select * from myc_rozmowa_decisions where (p_status is null or status = p_status) order by at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) d
    left join myc_accounts a on a.id = d.decided_by), '[]'::jsonb);
end $$;
create or replace function public.myc_rozmowa_decide(p_id bigint, p_action text, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); my text; d myc_rozmowa_decisions; n text := left(nullif(btrim(coalesce(p_note, '')), ''), 200);
begin
  perform myc_acct_uid();
  my := myc_role_of(acc);
  if my is distinct from 'developer' then raise exception 'myc: tylko Developer' using errcode = '42501'; end if;
  select * into d from myc_rozmowa_decisions where id = p_id for update;
  if d.id is null then raise exception 'myc: brak decyzji' using errcode = '22023'; end if;
  if p_action = 'accept' and d.status = 'pending' then
    if d.account_id is not null then
      insert into myc_gchat_sanctions (account_id, muted_until, reason, by_account) values (d.account_id, now() + make_interval(mins => coalesce(d.minutes, 60)), left('propozycja grzybni: ' || d.reason, 200), acc)
        on conflict (account_id) do update set muted_until = excluded.muted_until, reason = excluded.reason, by_account = acc, at = now();
    end if;
    update myc_rozmowa_decisions set status = 'accepted', decided_by = acc, decided_at = now(), note = n where id = d.id;
  elsif p_action = 'reject' and d.status = 'pending' then
    update myc_rozmowa_decisions set status = 'rejected', decided_by = acc, decided_at = now(), note = n where id = d.id;
  elsif p_action = 'revert' and d.status in ('applied', 'accepted') and d.kind in ('mute_auto', 'propose') then
    update myc_gchat_sanctions set muted_until = null, by_account = acc, at = now() where account_id = d.account_id;
    update myc_rozmowa_decisions set status = 'reverted', decided_by = acc, decided_at = now(), note = n where id = d.id;
  else raise exception 'myc: zła akcja dla tej decyzji' using errcode = '22023';
  end if;
  insert into myc_mod_log (room, actor, actor_role, action, target, detail) values ('main', acc, 'developer', 'decision_' || p_action, d.account_id, jsonb_build_object('decision', d.id, 'note', n));
  return jsonb_build_object('ok', true);
end $$;
-- Developer: sterowanie rozmówcą
create or replace function public.myc_rozmowa_admin(p_action text, p_value int default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id();
begin
  perform myc_acct_uid();
  if myc_role_of(acc) is distinct from 'developer' then raise exception 'myc: tylko Developer' using errcode = '42501'; end if;
  case p_action
    when 'pause' then update myc_rozmowa_cfg set enabled = false, updated_at = now() where id = 1;
    when 'resume' then update myc_rozmowa_cfg set enabled = true, updated_at = now() where id = 1;
    when 'every_n' then update myc_rozmowa_cfg set interject_every_n = p_value, updated_at = now() where id = 1;
    when 'min_s' then update myc_rozmowa_cfg set interject_min_s = p_value, updated_at = now() where id = 1;
    when 'invite_quiet' then update myc_rozmowa_cfg set invite_quiet_min = p_value, updated_at = now() where id = 1;
    else raise exception 'myc: zła akcja' using errcode = '22023';
  end case;
  insert into myc_mod_log (room, actor, actor_role, action, detail) values ('main', acc, 'developer', 'rozmowa_' || p_action, jsonb_build_object('value', p_value));
  return myc_rozmowa_state();
end $$;

-- Weryfikuj: ukryj / przywróć pozycję kolejki (Developer albo klucz właściciela). Dziennik: myc_mod_log + wiersz tabeli.
create or replace function public.myc_review_hide(p_key text, p_type text, p_ref text, p_reason text, p_room text default 'main') returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare who text := myc_rozmowa_dev(p_key); r text := left(nullif(btrim(coalesce(p_reason, '')), ''), 200);
begin
  if who is null then raise exception 'myc: tylko Developer' using errcode = '42501'; end if;
  if r is null then raise exception 'myc: podaj powód' using errcode = '22023'; end if;
  insert into myc_review_hidden (room, item_type, item_ref, reason, hidden_by) values (p_room, p_type, p_ref, r, who)
    on conflict (room, item_type, item_ref) do update set reason = excluded.reason, hidden_by = who, hidden_at = now(), restored_at = null, restored_by = null;
  insert into myc_mod_log (room, actor, actor_role, action, detail) values (p_room, myc_acct_id(), case when who = 'owner_key' then 'owner_key' else 'developer' end, 'review_hide',
    jsonb_build_object('type', p_type, 'ref', p_ref, 'reason', r));
  return jsonb_build_object('ok', true);
end $$;
create or replace function public.myc_review_restore(p_key text, p_type text, p_ref text, p_room text default 'main') returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare who text := myc_rozmowa_dev(p_key);
begin
  if who is null then raise exception 'myc: tylko Developer' using errcode = '42501'; end if;
  update myc_review_hidden set restored_at = now(), restored_by = who where room = p_room and item_type = p_type and item_ref = p_ref and restored_at is null;
  insert into myc_mod_log (room, actor, actor_role, action, detail) values (p_room, myc_acct_id(), case when who = 'owner_key' then 'owner_key' else 'developer' end, 'review_restore',
    jsonb_build_object('type', p_type, 'ref', p_ref));
  return jsonb_build_object('ok', true);
end $$;
-- lista ukrytych: publicznie tylko klucze (żeby kolejka ich nie pokazywała); szczegóły (kto, kiedy, dlaczego) – Developer
create or replace function public.myc_review_hidden_keys(p_room text default 'main') returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(item_type || '|' || item_ref), '{}') from myc_review_hidden where room = p_room and restored_at is null
$$;
create or replace function public.myc_review_hidden_list(p_key text, p_room text default 'main') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if myc_rozmowa_dev(p_key) is null then raise exception 'myc: tylko Developer' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(h) order by h.hidden_at desc) from (select * from myc_review_hidden where room = p_room order by hidden_at desc limit 200) h), '[]'::jsonb);
end $$;

-- Sprzątanie (pg_cron co godzinę): tokeny rozbioru > 30 dni, surowa pamięć > 180 dni (zostaje podsumowanie dnia),
-- zdarzenia relacji > 90 dni (liczniki zostają w stanie), oceny > 180 dni.
create or replace function public.myc_rozmowa_gc() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a int; b int; c int;
begin
  update myc_chat_mem set parse = parse - 'toks' where at < now() - interval '30 days' and parse ? 'toks'; get diagnostics a = row_count;
  delete from myc_chat_mem where at < now() - interval '180 days'; get diagnostics b = row_count;
  delete from myc_self_rel_events where at < now() - interval '90 days'; get diagnostics c = row_count;
  delete from myc_rozmowa_votes where at < now() - interval '180 days';
  -- program nauczania z czatu: najwyżej 500 najnowszych pytań na poziom
  delete from myc_speaker_chatq q where (q.level, q.text) in (select level, text from (select level, text, row_number() over (partition by level order by at desc) rn from myc_speaker_chatq) z where rn > 500);
  return jsonb_build_object('toks', a, 'mem', b, 'events', c);
end $$;
revoke all on function public.myc_rozmowa_gc() from public, anon, authenticated;

-- Nauka z czatu (proces rozmówcy, klucz): krótkie pytania osób → program nauczania mówcy (myc_speaker_chatq, L0/L1),
-- zdania „X jest Y” → strzępek do Weryfikuj (myc_frag_add, źródło 'chat', zaufanie 0,4). Zgodę sprawdza baza.
create table if not exists public.myc_speaker_chatq (
  level int not null check (level between 0 and 1),
  text text not null check (char_length(text) between 3 and 80),
  msg_id bigint,
  conf real not null,
  at timestamptz not null default now(),
  primary key (level, text)
);
alter table public.myc_speaker_chatq enable row level security;
revoke all on public.myc_speaker_chatq from public, anon, authenticated;

create or replace function public.myc_rozmowa_learn(p_key text, p_msg bigint, p_q jsonb default null, p_fact jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare ok boolean; out jsonb := '{}'; r jsonb;
begin
  if not myc_rozmowa_key_ok(p_key) then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  select p.train_ok and coalesce(f.train_ok, true) into ok
    from myc_gchat_priv p join myc_gchat m on m.id = p.msg_id left join myc_account_prefs f on f.account_id = p.account_id
   where p.msg_id = p_msg and m.room = 'main' and m.circle_id is null and m.kind = 'user' and not m.deleted;
  if not coalesce(ok, false) then return jsonb_build_object('skipped', 'brak zgody'); end if;
  if p_q is not null and (p_q->>'level')::int between 0 and 1 and char_length(p_q->>'text') between 3 and 80 then
    insert into myc_speaker_chatq (level, text, msg_id, conf) values ((p_q->>'level')::int, lower(btrim(p_q->>'text')), p_msg, least(greatest(coalesce((p_q->>'conf')::real, 0.5), 0), 1))
      on conflict (level, text) do nothing;
    out := out || jsonb_build_object('q', found);
  end if;
  if p_fact is not null and coalesce(p_fact->>'rel', '') = 'jest' then
    r := myc_frag_add('7a3f0e52-6b1d-4c8e-9f20-726f7a6d6f77'::uuid,
      jsonb_build_array(jsonb_build_object('layer', 0, 'subj', left(p_fact->>'subj', 80), 'rel', 'jest', 'obj', left(p_fact->>'obj', 120), 'lang', 'pl',
        'source', 'chat', 'ref', 'czat globalny #' || p_msg)), '[]'::jsonb, 'main');
    out := out || jsonb_build_object('fact', r);
  end if;
  return out;
end $$;
revoke all on function public.myc_rozmowa_learn(text, bigint, jsonb, jsonb) from public;
grant execute on function public.myc_rozmowa_learn(text, bigint, jsonb, jsonb) to anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array['myc_rozmowa_pending(text, text, integer)', 'myc_rozmowa_recall(text, text, text[], bigint, integer)',
    'myc_rozmowa_submit(text, bigint, jsonb, jsonb, text[], jsonb, jsonb)', 'myc_rozmowa_invite(text, jsonb)',
    'myc_rozmowa_meta(bigint[])', 'myc_rozmowa_parse(bigint)', 'myc_rozmowa_state()', 'myc_self_relations_status()', 'myc_self_rel_decisions(integer)',
    'myc_review_hide(text, text, text, text, text)', 'myc_review_restore(text, text, text, text)', 'myc_review_hidden_keys(text)', 'myc_review_hidden_list(text, text)'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array['myc_rozmowa_rate(bigint, smallint, text)', 'myc_self_relation_me(text)', 'myc_self_relation_forget()',
    'myc_rozmowa_decisions_list(text, integer)', 'myc_rozmowa_decide(bigint, text, text)', 'myc_rozmowa_admin(text, integer)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'myc_rozmowa_gc') then perform cron.unschedule('myc_rozmowa_gc'); end if;
  perform cron.schedule('myc_rozmowa_gc', '17 * * * *', 'select public.myc_rozmowa_gc()');
end $$;
