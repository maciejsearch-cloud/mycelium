-- Czat globalny grzybni (25.10.2026): ludzie (anonimowe konta, pseudonim) i boty węzłów (oznaczone), na żywo
-- przez Supabase Realtime (postgres_changes; RLS obowiązuje także dla subskrypcji).
-- Zasady:
--  • zapis WYŁĄCZNIE przez funkcje (myc_gchat_post / myc_gchat_node_post) – autor wynika z sesji (auth.uid → konto),
--    klient nie może podać cudzego konta ani roli; brak bezpośrednich praw INSERT/UPDATE/DELETE dla anon/authenticated,
--  • limity: 8 wiadomości/min na konto, 3/min na węzeł, limit na adres klienta (cf-connecting-ip, myc_rl),
--    ta sama treść dwa razy w 2 min odrzucona, maks. 1000 znaków,
--  • BEZ cenzury słów: wulgaryzmy dostają tylko etykietę rejestru (tags); moderacja robi człowiek (Developer/Moderator),
--  • w tabelach czatu NIE zapisujemy adresu IP (limiter trzyma tylko skrót IP w myc_rate przez ≤ 1 h),
--  • powiązanie wiadomość → konto jest w prywatnej tabeli myc_gchat_priv (niewidocznej przez REST).
-- Role: 'developer' (właściciel – nadawana kluczem właściciela, sprawdzanym po skrócie w myc_owner; każde
-- urządzenie, które poda klucz, przypina rolę do swojego konta) i 'moderator' (nadaje Developer). Dziennik moderacji.

-- Role kont
create table if not exists public.myc_roles (
  account_id uuid primary key references public.myc_accounts (id) on delete cascade,
  role text not null check (role in ('developer', 'moderator')),
  via text not null check (via in ('owner_key', 'granted')),
  granted_by uuid references public.myc_accounts (id) on delete set null,
  granted_at timestamptz not null default now()
);
-- Urządzenia, które potwierdziły klucz właściciela (bez klucza – tylko fakt potwierdzenia)
create table if not exists public.myc_owner_devices (
  user_id uuid primary key references auth.users (id) on delete cascade,
  account_id uuid not null references public.myc_accounts (id) on delete cascade,
  claimed_at timestamptz not null default now()
);
-- Ustawienia prywatności konta: czy moje wiadomości mogą uczyć model (domyślnie tak, przełącznik widoczny w czacie)
create table if not exists public.myc_account_prefs (
  account_id uuid primary key references public.myc_accounts (id) on delete cascade,
  train_ok boolean not null default true,
  updated_at timestamptz not null default now()
);
-- Wyciszenia / bany
create table if not exists public.myc_gchat_sanctions (
  account_id uuid primary key references public.myc_accounts (id) on delete cascade,
  muted_until timestamptz,
  banned boolean not null default false,
  reason text check (reason is null or char_length(reason) <= 200),
  by_account uuid references public.myc_accounts (id) on delete set null,
  at timestamptz not null default now()
);

create table if not exists public.myc_gchat (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  circle_id bigint,                                     -- null = kanał globalny; inaczej kanał kręgu (myc_circles.sql)
  kind text not null check (kind in ('user', 'node')),
  handle text not null check (char_length(handle) between 1 and 40),
  role text check (role is null or role in ('developer', 'moderator')),
  body text check (body is null or char_length(body) between 1 and 1000),
  reply_to bigint references public.myc_gchat (id) on delete set null,
  intent text check (intent is null or intent in ('pytanie', 'emocja', 'niezgoda', 'stwierdzenie', 'powitanie', 'ironia')),
  tags text[] not null default '{}' check (cardinality(tags) <= 6 and tags <@ array['wulgarne', 'potoczne', 'obraźliwe', 'slang', 'ironiczne', 'skrót', 'emotikon']::text[]),
  pinned boolean not null default false,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  check (deleted or body is not null)
);
create index if not exists myc_gchat_time on public.myc_gchat (room, circle_id, id desc);
create index if not exists myc_gchat_pinned on public.myc_gchat (room, circle_id) where pinned;

create table if not exists public.myc_gchat_priv (
  msg_id bigint primary key references public.myc_gchat (id) on delete cascade,
  account_id uuid references public.myc_accounts (id) on delete set null,
  node_id uuid,
  train_ok boolean not null default false,
  body_hash text not null,
  processed_at timestamptz
);
create index if not exists myc_gchat_priv_acc on public.myc_gchat_priv (account_id);
create index if not exists myc_gchat_priv_todo on public.myc_gchat_priv (msg_id) where processed_at is null;

create table if not exists public.myc_mod_log (
  id bigint generated always as identity primary key,
  room text not null default 'main',
  at timestamptz not null default now(),
  actor uuid references public.myc_accounts (id) on delete set null,
  actor_role text not null check (actor_role in ('developer', 'moderator', 'user', 'owner_key', 'system')),
  action text not null check (action ~ '^[a-z_]{2,24}$'),
  msg_id bigint,
  target uuid,
  detail jsonb not null default '{}' check (pg_column_size(detail) < 4000)
);
create index if not exists myc_mod_log_time on public.myc_mod_log (room, at desc);

alter table public.myc_roles enable row level security;
alter table public.myc_owner_devices enable row level security;
alter table public.myc_account_prefs enable row level security;
alter table public.myc_gchat_sanctions enable row level security;
alter table public.myc_gchat enable row level security;
alter table public.myc_gchat_priv enable row level security;
alter table public.myc_mod_log enable row level security;
revoke all on public.myc_roles, public.myc_owner_devices, public.myc_account_prefs, public.myc_gchat_sanctions,
  public.myc_gchat, public.myc_gchat_priv, public.myc_mod_log from public, anon, authenticated;
grant select on public.myc_gchat to anon, authenticated;
drop policy if exists myc_gchat_read on public.myc_gchat;
create policy myc_gchat_read on public.myc_gchat for select to anon, authenticated using (circle_id is null);

-- Realtime: nowe/zmienione wiadomości (RLS decyduje, kto je dostaje)
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'myc_gchat') then
    execute 'alter publication supabase_realtime add table public.myc_gchat';
  end if;
end $$;

create or replace function public.myc_role_of(p_acc uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from myc_roles where account_id = p_acc
$$;
revoke execute on function public.myc_role_of(uuid) from public, anon, authenticated;

create or replace function public.myc_gchat_me() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); a myc_accounts; s myc_gchat_sanctions;
begin
  if acc is null then return null; end if;
  select * into a from myc_accounts where id = acc;
  select * into s from myc_gchat_sanctions where account_id = acc;
  return jsonb_build_object('account', acc, 'handle', a.handle, 'room', a.room, 'role', myc_role_of(acc),
    'owner_device', exists (select 1 from myc_owner_devices where user_id = auth.uid()),
    'muted_until', case when s.muted_until > now() then s.muted_until end, 'banned', coalesce(s.banned, false),
    'train_ok', coalesce((select train_ok from myc_account_prefs where account_id = acc), true));
end $$;

-- Klucz właściciela → rola Developer dla konta TEGO urządzenia (kilka urządzeń = kilka wpisów; klucz nie jest zapisywany).
create or replace function public.myc_gchat_claim_owner(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := myc_acct_uid(); acc uuid := myc_acct_id(); rm text;
begin
  perform myc_rl('owner_claim:' || myc_ip(), 5);
  if acc is null then raise exception 'myc: najpierw załóż konto' using errcode = '42501'; end if;
  rm := myc_key_room(p_key);
  if rm is null or rm <> (select room from myc_accounts where id = acc) then raise exception 'myc: zły klucz' using errcode = '28000'; end if;
  insert into myc_roles (account_id, role, via) values (acc, 'developer', 'owner_key')
    on conflict (account_id) do update set role = 'developer', via = 'owner_key', granted_by = null, granted_at = now();
  insert into myc_owner_devices (user_id, account_id) values (uid, acc)
    on conflict (user_id) do update set account_id = excluded.account_id, claimed_at = now();
  insert into myc_mod_log (room, actor, actor_role, action, target) values (rm, acc, 'owner_key', 'claim_developer', acc);
  return myc_gchat_me();
end $$;

create or replace function public.myc_gchat_set_train(p_ok boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id();
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: brak konta' using errcode = '42501'; end if;
  perform myc_rl('gchat_pref:' || acc, 10);
  insert into myc_account_prefs (account_id, train_ok) values (acc, coalesce(p_ok, true))
    on conflict (account_id) do update set train_ok = excluded.train_ok, updated_at = now();
  if not coalesce(p_ok, true) then
    update myc_gchat_priv set train_ok = false where account_id = acc;
    -- oczekujące próbki zdań z moich wiadomości znikają (zatwierdzone wzorce są zbiorcze i bez danych osoby)
    delete from myc_lang_patterns p using myc_lang_src s join myc_gchat_priv g on g.msg_id = s.msg_id
     where s.pattern_id = p.id and g.account_id = acc and p.status = 'pending' and p.kind in ('intencja', 'ironia');
  end if;
  return myc_gchat_me();
end $$;

-- Wpis do czatu jako JA (konto z sesji). p_intent / p_tags: wynik klasyfikatora w przeglądarce (tylko z listy).
create or replace function public.myc_gchat_post(p_body text, p_reply_to bigint default null, p_intent text default null,
  p_tags text[] default '{}', p_circle bigint default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare acc uuid := myc_acct_id(); a myc_accounts; s myc_gchat_sanctions; b text := btrim(coalesce(p_body, '')); h text; id_ bigint; tr boolean;
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: załóż konto (Konto → pseudonim), żeby pisać' using errcode = '42501'; end if;
  select * into a from myc_accounts where id = acc;
  select * into s from myc_gchat_sanctions where account_id = acc;
  if coalesce(s.banned, false) then raise exception 'myc: konto zablokowane w czacie' using errcode = '42501'; end if;
  if s.muted_until > now() then raise exception 'myc: wyciszenie do %', to_char(s.muted_until at time zone 'Europe/Amsterdam', 'DD.MM HH24:MI') using errcode = '42501'; end if;
  if char_length(b) not between 1 and 1000 then raise exception 'myc: wiadomość 1–1000 znaków' using errcode = '22023'; end if;
  if p_circle is not null and not coalesce(myc_gchat_can_circle(p_circle, acc, false), false) then raise exception 'myc: nie jesteś w tym kręgu' using errcode = '42501'; end if;
  if p_circle is not null and not coalesce(myc_gchat_can_circle(p_circle, acc, true), false) then raise exception 'myc: krąg zamrożony przez Developera – czat kręgu tylko do odczytu' using errcode = '42501'; end if;
  perform myc_rl('gchat:' || acc, 8);
  perform myc_rl('gchat_room:' || a.room, 240);
  h := encode(digest(lower(regexp_replace(b, '\s+', ' ', 'g')), 'sha256'), 'hex');
  if exists (select 1 from myc_gchat_priv p join myc_gchat m on m.id = p.msg_id
             where p.account_id = acc and p.body_hash = h and m.created_at > now() - interval '2 minutes') then
    raise exception 'myc: ta sama wiadomość przed chwilą' using errcode = 'PT429';
  end if;
  if p_reply_to is not null and not exists (select 1 from myc_gchat where id = p_reply_to and room = a.room and circle_id is not distinct from p_circle) then p_reply_to := null; end if;
  tr := coalesce((select train_ok from myc_account_prefs where account_id = acc), true);
  insert into myc_gchat (room, circle_id, kind, handle, role, body, reply_to, intent, tags)
  values (a.room, p_circle, 'user', a.handle, myc_role_of(acc), b, p_reply_to,
          case when p_intent in ('pytanie', 'emocja', 'niezgoda', 'stwierdzenie', 'powitanie', 'ironia') then p_intent end,
          coalesce((select array_agg(distinct t) from unnest(coalesce(p_tags, '{}')) t
                    where t in ('wulgarne', 'potoczne', 'obraźliwe', 'slang', 'ironiczne', 'skrót', 'emotikon')), '{}'))
  returning id into id_;
  insert into myc_gchat_priv (msg_id, account_id, train_ok, body_hash) values (id_, acc, tr and p_circle is null, h);
  return jsonb_build_object('id', id_);
end $$;

-- Bot węzła: tylko węzeł, który w ostatnich 7 dniach oddał prawdziwy wynik lub zdarzenie wzrostu (pokój e2e: każdy).
create or replace function public.myc_gchat_node_post(p_node uuid, p_body text, p_room text default 'main', p_agent text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare b text := btrim(coalesce(p_body, '')); id_ bigint; ag text := nullif(btrim(coalesce(p_agent, '')), '');
begin
  if p_node is null or p_room not in ('main', 'e2e') then raise exception 'myc: węzeł' using errcode = '22023'; end if;
  if char_length(b) not between 1 and 500 then raise exception 'myc: wiadomość węzła 1–500 znaków' using errcode = '22023'; end if;
  if ag is not null and (char_length(ag) > 24 or ag ~ '[<>"`\\[:cntrl:]]') then ag := null; end if;
  if p_room = 'main' and not exists (select 1 from myc_results where node_id = p_node and created_at > now() - interval '7 days')
     and not exists (select 1 from myc_growth where node_id = p_node and created_at > now() - interval '7 days') then
    raise exception 'myc: nieznany węzeł (najpierw prawdziwy wkład)' using errcode = '42501';
  end if;
  if exists (select 1 from myc_gchat_sanctions s join myc_account_nodes n on n.account_id = s.account_id
             where n.node_id = p_node and (s.banned or s.muted_until > now())) then
    raise exception 'myc: węzeł wyciszony' using errcode = '42501';
  end if;
  perform myc_rl('gchat_node:' || p_node, 3);
  insert into myc_gchat (room, kind, handle, body)
  values (p_room, 'node', 'węzeł·' || left(replace(p_node::text, '-', ''), 6) || coalesce(' ' || ag, ''), b)
  returning id into id_;
  insert into myc_gchat_priv (msg_id, node_id, train_ok, body_hash) values (id_, p_node, false, encode(digest(b, 'sha256'), 'hex'));
  return jsonb_build_object('id', id_);
end $$;

-- Moderacja. Developer: wszystko; Moderator: przypinanie, usuwanie, wyciszenie ≤ 24 h (nie wobec Developera/Moderatora).
-- Każdy może usunąć własną wiadomość. Każda akcja = wpis w myc_mod_log.
create or replace function public.myc_gchat_mod(p_action text, p_msg bigint default null, p_minutes int default null,
  p_role text default null, p_reason text default null, p_handle text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); my text; rm text; m myc_gchat; tgt uuid; trole text; r text := left(nullif(btrim(coalesce(p_reason, '')), ''), 200);
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: brak konta' using errcode = '42501'; end if;
  my := myc_role_of(acc);
  rm := (select room from myc_accounts where id = acc);
  perform myc_rl('gchat_mod:' || acc, 60);
  if p_msg is not null then
    select * into m from myc_gchat where id = p_msg and room = rm;
    if m.id is null then raise exception 'myc: brak wiadomości' using errcode = '22023'; end if;
    select account_id into tgt from myc_gchat_priv where msg_id = m.id;
    if tgt is null then select n.account_id into tgt from myc_gchat_priv p join myc_account_nodes n on n.node_id = p.node_id where p.msg_id = m.id; end if;
  elsif p_handle is not null then
    select id into tgt from myc_accounts where room = rm and lower(handle) = lower(btrim(p_handle));
    if tgt is null then raise exception 'myc: brak takiego pseudonimu' using errcode = '22023'; end if;
  end if;
  trole := myc_role_of(tgt);

  if p_action = 'delete' and tgt = acc and my is null then
    update myc_gchat set body = null, deleted = true, pinned = false where id = m.id;
    insert into myc_mod_log (room, actor, actor_role, action, msg_id, target) values (rm, acc, 'user', 'self_delete', m.id, acc);
    return jsonb_build_object('ok', true);
  end if;
  if my is null then raise exception 'myc: brak uprawnień (Developer/Moderator)' using errcode = '42501'; end if;
  if my = 'moderator' and (p_action not in ('pin', 'unpin', 'delete', 'mute', 'unmute') or (trole is not null and tgt <> acc)) then
    raise exception 'myc: tylko Developer' using errcode = '42501';
  end if;
  if p_action in ('mute', 'ban') and tgt = acc then raise exception 'myc: nie na sobie' using errcode = '22023'; end if;

  case p_action
    when 'pin', 'unpin' then
      if m.id is null then raise exception 'myc: wiadomość?' using errcode = '22023'; end if;
      update myc_gchat set pinned = (p_action = 'pin') where id = m.id and not deleted;
    when 'delete' then
      if m.id is null then raise exception 'myc: wiadomość?' using errcode = '22023'; end if;
      update myc_gchat set body = null, deleted = true, pinned = false where id = m.id;
    when 'mute' then
      if tgt is null then raise exception 'myc: kogo?' using errcode = '22023'; end if;
      insert into myc_gchat_sanctions (account_id, muted_until, reason, by_account)
      values (tgt, now() + make_interval(mins => least(greatest(coalesce(p_minutes, 60), 1), case when my = 'developer' then 525600 else 1440 end)), r, acc)
      on conflict (account_id) do update set muted_until = excluded.muted_until, reason = excluded.reason, by_account = acc, at = now();
    when 'unmute' then
      update myc_gchat_sanctions set muted_until = null, by_account = acc, at = now() where account_id = tgt;
    when 'ban' then
      if tgt is null then raise exception 'myc: kogo?' using errcode = '22023'; end if;
      insert into myc_gchat_sanctions (account_id, banned, reason, by_account) values (tgt, true, r, acc)
      on conflict (account_id) do update set banned = true, reason = excluded.reason, by_account = acc, at = now();
    when 'unban' then
      update myc_gchat_sanctions set banned = false, muted_until = null, by_account = acc, at = now() where account_id = tgt;
    when 'grant_role' then
      if tgt is null or p_role is distinct from 'moderator' then raise exception 'myc: nadać można rolę moderator' using errcode = '22023'; end if;
      if trole = 'developer' then raise exception 'myc: to Developer' using errcode = '22023'; end if;
      insert into myc_roles (account_id, role, via, granted_by) values (tgt, 'moderator', 'granted', acc)
      on conflict (account_id) do update set role = 'moderator', via = 'granted', granted_by = acc, granted_at = now();
    when 'revoke_role' then
      if tgt is null or tgt = acc then raise exception 'myc: kogo?' using errcode = '22023'; end if;
      delete from myc_roles where account_id = tgt and role = 'moderator';
    else raise exception 'myc: nieznana akcja' using errcode = '22023';
  end case;
  insert into myc_mod_log (room, actor, actor_role, action, msg_id, target, detail)
  values (rm, acc, my, p_action, m.id, tgt, jsonb_strip_nulls(jsonb_build_object('minutes', p_minutes, 'role', p_role, 'reason', r)));
  return jsonb_build_object('ok', true, 'action', p_action);
end $$;

-- Dziennik moderacji (Developer/Moderator): kto, co, kiedy – pseudonimy, bez identyfikatorów urządzeń i IP.
create or replace function public.myc_gchat_modlog(p_limit int default 50) returns table (at timestamptz, actor text, actor_role text, action text, msg_id bigint, target text, detail jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id();
begin
  if myc_role_of(acc) is null then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  return query select l.at, a.handle, l.actor_role, l.action, l.msg_id, t.handle, l.detail
    from myc_mod_log l left join myc_accounts a on a.id = l.actor left join myc_accounts t on t.id = l.target
   where l.room = (select room from myc_accounts where id = acc) order by l.at desc limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

-- Osoby z rolami (pseudonimy) – widoczne dla wszystkich, żeby było jasne, kto moderuje.
create or replace function public.myc_gchat_roles(p_room text default 'main') returns table (handle text, role text, granted_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.handle, r.role, r.granted_at from myc_roles r join myc_accounts a on a.id = r.account_id where a.room = p_room order by r.role, a.handle
$$;

-- Publiczne liczniki czatu (prawdziwe, z bazy)
create or replace function public.myc_gchat_stats(p_room text default 'main') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'messages', (select count(*) from myc_gchat where room = p_room and circle_id is null and not deleted),
    'today', (select count(*) from myc_gchat where room = p_room and circle_id is null and not deleted and created_at > date_trunc('day', now() at time zone 'Europe/Amsterdam') at time zone 'Europe/Amsterdam'),
    'people', (select count(distinct p.account_id) from myc_gchat m join myc_gchat_priv p on p.msg_id = m.id where m.room = p_room and m.kind = 'user'),
    'nodes', (select count(distinct p.node_id) from myc_gchat m join myc_gchat_priv p on p.msg_id = m.id where m.room = p_room and m.kind = 'node'),
    'opted_out', (select count(*) from myc_account_prefs f join myc_accounts a on a.id = f.account_id where a.room = p_room and not f.train_ok))
$$;

-- Kanały kręgów: zastępuje myc_circles.sql (tu bezpieczny domyślny „nie”).
create or replace function public.myc_gchat_can_circle(p_circle bigint, p_acc uuid, p_write boolean) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select false $$;
revoke execute on function public.myc_gchat_can_circle(bigint, uuid, boolean) from public, anon, authenticated;

-- Sprzątanie pokoju testów e2e (tylko kluczem e2e)
create or replace function public.myc_gchat_e2e_cleanup(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int; b int;
begin
  if myc_key_room(p_key) is distinct from 'e2e' then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  delete from myc_gchat where room = 'e2e'; get diagnostics a = row_count;
  delete from myc_mod_log where room = 'e2e';
  delete from myc_lang_patterns where room = 'e2e'; get diagnostics b = row_count;
  delete from myc_lang_seen where room = 'e2e';
  return jsonb_build_object('messages', a, 'patterns', b);
end $$;

do $$
declare f text;
begin
  foreach f in array array['myc_gchat_me()', 'myc_gchat_claim_owner(text)', 'myc_gchat_set_train(boolean)',
    'myc_gchat_post(text, bigint, text, text[], bigint)', 'myc_gchat_mod(text, bigint, integer, text, text, text)', 'myc_gchat_modlog(integer)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['myc_gchat_node_post(uuid, text, text, text)', 'myc_gchat_roles(text)', 'myc_gchat_stats(text)', 'myc_gchat_e2e_cleanup(text)'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
