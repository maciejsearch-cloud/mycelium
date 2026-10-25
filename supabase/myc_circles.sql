-- „Kręgi” (25.10.2026): małe grupy znajomych na kontach anonimowych – zaproszenie kodem, właściciel/admini,
-- limit liczby osób, kanał kręgu w czacie globalnym, zaufanie liczone WYŁĄCZNIE ze zweryfikowanego wkładu,
-- poręczenia (stawka z własnego zaufania), zamrożenie kręgu przez Developera, dziennik zdarzeń kręgu.
-- Dane kręgu widzą tylko jego członkowie (tabele bez praw dla anon/authenticated; odczyt przez funkcje
-- sprawdzające członkostwo; wiadomości kręgu w myc_gchat filtruje RLS – także w Realtime).
-- Kod zaproszenia: pokazywany raz, w bazie tylko SHA-256; można go w każdej chwili wymienić.

create table if not exists public.myc_circles (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  name text not null check (name ~ '^[[:alnum:] _.-]{3,40}$'),
  about text check (about is null or char_length(about) <= 200),
  owner_account uuid not null references public.myc_accounts (id) on delete cascade,
  max_size int not null default 30 check (max_size between 2 and 200),
  invite_hash text unique,
  invite_at timestamptz,
  spec text check (spec is null or spec in ('jezyk', 'obrazy', 'logika', 'zrodla')),
  frozen boolean not null default false,
  frozen_reason text check (frozen_reason is null or char_length(frozen_reason) <= 200),
  created_at timestamptz not null default now()
);
create unique index if not exists myc_circles_name_uq on public.myc_circles (room, lower(name));

create table if not exists public.myc_circle_members (
  circle_id bigint not null references public.myc_circles (id) on delete cascade,
  account_id uuid not null references public.myc_accounts (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (circle_id, account_id)
);
create index if not exists myc_circle_members_acc on public.myc_circle_members (account_id);

create table if not exists public.myc_vouches (
  id bigint generated always as identity primary key,
  circle_id bigint not null references public.myc_circles (id) on delete cascade,
  voucher uuid not null references public.myc_accounts (id) on delete cascade,
  newcomer uuid not null references public.myc_accounts (id) on delete cascade,
  stake real not null check (stake between 0.02 and 0.2),
  status text not null default 'active' check (status in ('active', 'released', 'slashed')),
  reason text check (reason is null or char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (voucher <> newcomer)
);
create unique index if not exists myc_vouches_one on public.myc_vouches (newcomer) where status = 'active';
create index if not exists myc_vouches_voucher on public.myc_vouches (voucher, status);

create table if not exists public.myc_circle_log (
  id bigint generated always as identity primary key,
  circle_id bigint not null references public.myc_circles (id) on delete cascade,
  at timestamptz not null default now(),
  actor uuid references public.myc_accounts (id) on delete set null,
  action text not null check (action ~ '^[a-z_]{2,24}$'),
  target uuid references public.myc_accounts (id) on delete set null,
  detail jsonb not null default '{}' check (pg_column_size(detail) < 2000)
);
create index if not exists myc_circle_log_c on public.myc_circle_log (circle_id, at desc);

alter table public.myc_circles enable row level security;
alter table public.myc_circle_members enable row level security;
alter table public.myc_vouches enable row level security;
alter table public.myc_circle_log enable row level security;
revoke all on public.myc_circles, public.myc_circle_members, public.myc_vouches, public.myc_circle_log from public, anon, authenticated;

alter table public.myc_gchat drop constraint if exists myc_gchat_circle_fk;
alter table public.myc_gchat add constraint myc_gchat_circle_fk foreign key (circle_id) references public.myc_circles (id) on delete cascade;

create or replace function public.myc_circle_is_member(p_circle bigint) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from myc_circle_members where circle_id = p_circle and account_id = myc_acct_id())
$$;
revoke execute on function public.myc_circle_is_member(bigint) from public, anon;
grant execute on function public.myc_circle_is_member(bigint) to authenticated;  -- potrzebne w polityce RLS

-- Wiadomości kręgu widzą tylko członkowie (RLS obowiązuje też w Realtime)
drop policy if exists myc_gchat_read on public.myc_gchat;
create policy myc_gchat_read on public.myc_gchat for select to anon using (circle_id is null);
drop policy if exists myc_gchat_read_auth on public.myc_gchat;
create policy myc_gchat_read_auth on public.myc_gchat for select to authenticated using (circle_id is null or public.myc_circle_is_member(circle_id));

create or replace function public.myc_gchat_can_circle(p_circle bigint, p_acc uuid, p_write boolean) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from myc_circle_members m join myc_circles c on c.id = m.circle_id
                  where m.circle_id = p_circle and m.account_id = p_acc and (not p_write or not c.frozen))
$$;
revoke execute on function public.myc_gchat_can_circle(bigint, uuid, boolean) from public, anon, authenticated;

-- ZAUFANIE: tylko zweryfikowany wkład (nigdy deklaracje). Składniki są jawne dla właściciela konta (myc_trust_me).
--  approved  – zatwierdzone punkty wkładu (bez poleceń – polecenia nie podnoszą zaufania, anty-Sybil),
--  gold      – zgodność głosów/odpowiedzi węzłów konta ze złotymi etykietami (Beta 3:1, liczone od 5 odpowiedzi),
--  days      – dni z prawdziwą aktywnością w ostatnich 30 (zaakceptowane wyniki, zatwierdzone punkty),
--  witness   – poświadczenia świadka wydane przez węzły konta (30 dni),
--  kara      – odrzucone punkty i głosy sprzeczne z decyzją właścicielki („kłamstwo”),
--  wygaszanie – po 7 dniach bez aktywności zaufanie maleje (e^(−dni/30)); nowe konto (< 7 dni) maks. 0,3,
--  poręczenia – poręczyciel traci stawkę na czas poręczenia (i na zawsze, gdy nowicjusz oszukiwał);
--               nowicjusz dostaje połowę stawki (maks. 0,15) do czasu rozliczenia.
create or replace function public.myc_trust_calc(p_acc uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare ap real; rj real; gn int; gc int; days int; wit int; wrong int; rightv int; last timestamptz; age real;
  q real := 0.5; raw real; pen real; dec real; base real; st_out real; st_in real; t real;
begin
  if p_acc is null then return null; end if;
  select coalesce(sum(points) filter (where status = 'approved' and source <> 'referral'), 0), coalesce(sum(points) filter (where status = 'rejected'), 0),
         max(coalesce(decided_at, created_at)) filter (where status = 'approved')
    into ap, rj, last from myc_points where account_id = p_acc;
  select coalesce(sum(s.n), 0), coalesce(sum(s.correct), 0) into gn, gc
    from myc_gold_stats() s join myc_account_nodes an on an.node_id = s.node_id where an.account_id = p_acc;
  select count(distinct d) into days from (
    select (r.created_at at time zone 'Europe/Amsterdam')::date d from myc_results r join myc_account_nodes an on an.node_id = r.node_id
     where an.account_id = p_acc and r.status = 'accepted' and r.created_at > now() - interval '30 days'
    union select (coalesce(decided_at, created_at) at time zone 'Europe/Amsterdam')::date from myc_points
     where account_id = p_acc and status = 'approved' and source <> 'referral' and coalesce(decided_at, created_at) > now() - interval '30 days') x;
  select greatest(last, (select max(r.created_at) from myc_results r join myc_account_nodes an on an.node_id = r.node_id where an.account_id = p_acc and r.status = 'accepted')) into last;
  select count(*) into wit from myc_witness w join myc_account_nodes an on an.node_id = w.node_id where an.account_id = p_acc and w.created_at > now() - interval '30 days';
  select count(*) filter (where v.vote <> (m.status = 'approved')), count(*) filter (where v.vote = (m.status = 'approved'))
    into wrong, rightv
    from (select meaning_id id, voter_node, vote from myc_meaning_votes where voter <> 'owner') v
    join myc_meanings m on m.id = v.id and m.decided_by = 'owner'
    join myc_account_nodes an on an.node_id = v.voter_node where an.account_id = p_acc;
  select wrong + count(*) filter (where v.vote <> (p.status = 'approved')), rightv + count(*) filter (where v.vote = (p.status = 'approved'))
    into wrong, rightv
    from myc_lang_votes v join myc_lang_patterns p on p.id = v.pattern_id and p.decided_by = 'owner'
    join myc_account_nodes an on an.node_id = v.voter_node where an.account_id = p_acc and v.voter <> 'owner';
  select extract(epoch from now() - created_at) / 86400 into age from myc_accounts where id = p_acc;
  if gn >= 5 then q := (gc + 3)::real / (gn + 4); end if;
  raw := 0.35 * (1 - exp(-ap / 40)) + 0.25 * greatest(0, (q - 0.5) * 2) + 0.25 * least(days, 30) / 30.0 + 0.15 * least(wit, 50) / 50.0;
  pen := 0.5 * rj / (ap + rj + 1) + 0.5 * wrong::real / (wrong + rightv + 3);
  dec := case when last is null then 1 else exp(-greatest(0, extract(epoch from now() - last) / 86400 - 7) / 30) end;
  base := 0.05 + 0.95 * raw * dec * (1 - pen);
  if age < 7 then base := least(base, 0.3); end if;
  select coalesce(sum(stake) filter (where status in ('active', 'slashed')), 0) into st_out from myc_vouches where voucher = p_acc;
  select coalesce(sum(stake) filter (where status = 'active'), 0) into st_in from myc_vouches where newcomer = p_acc;
  t := greatest(0, least(1, base - st_out + least(0.15, st_in * 0.5)));
  return jsonb_build_object('trust', round(t::numeric, 3), 'base', round(base::numeric, 3),
    'approved', ap, 'rejected', rj, 'gold_n', gn, 'gold_ok', gc, 'active_days_30', days, 'witness_30', wit,
    'wrong_votes', wrong, 'right_votes', rightv, 'decay', round(dec::numeric, 3), 'penalty', round(pen::numeric, 3),
    'new_account', age < 7, 'stake_out', st_out, 'vouch_bonus', least(0.15, st_in * 0.5), 'last_active', last);
end $$;
revoke execute on function public.myc_trust_calc(uuid) from public, anon, authenticated;

create or replace function public.myc_trust(p_acc uuid) returns real
language sql stable security definer set search_path = public, pg_temp as $$ select (myc_trust_calc(p_acc) ->> 'trust')::real $$;
revoke execute on function public.myc_trust(uuid) from public, anon, authenticated;

create or replace function public.myc_trust_me() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform myc_acct_uid();
  return myc_trust_calc(myc_acct_id());
end $$;

create or replace function public.myc_circle_logit(p_circle bigint, p_actor uuid, p_action text, p_target uuid default null, p_detail jsonb default '{}')
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into myc_circle_log (circle_id, actor, action, target, detail) values (p_circle, p_actor, p_action, p_target, coalesce(p_detail, '{}'))
$$;
revoke execute on function public.myc_circle_logit(bigint, uuid, text, uuid, jsonb) from public, anon, authenticated;

create or replace function public.myc_circle_new_invite(p_circle bigint) returns text
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare raw text; code text;
begin
  raw := upper(translate(encode(gen_random_bytes(9), 'base64'), '+/=0O1IL', 'XYZ89KMN'));
  code := 'KRG-' || substr(raw, 1, 4) || '-' || substr(raw, 5, 4) || '-' || substr(raw, 9, 4);
  update myc_circles set invite_hash = encode(digest(code, 'sha256'), 'hex'), invite_at = now() where id = p_circle;
  return code;
end $$;
revoke execute on function public.myc_circle_new_invite(bigint) from public, anon, authenticated;

create or replace function public.myc_circle_create(p_name text, p_about text default null, p_max int default 30) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); rm text; cid bigint; n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: najpierw załóż konto' using errcode = '42501'; end if;
  perform myc_rl('circle_new:' || acc, 3);
  rm := (select room from myc_accounts where id = acc);
  if n !~ '^[[:alnum:] _.-]{3,40}$' then raise exception 'myc: nazwa kręgu 3–40 znaków (litery, cyfry, spacja _ . -)' using errcode = '22023'; end if;
  if (select count(*) from myc_circles where owner_account = acc) >= 3 then raise exception 'myc: maks. 3 własne kręgi' using errcode = '22023'; end if;
  if (select count(*) from myc_circle_members where account_id = acc) >= 10 then raise exception 'myc: maks. 10 kręgów na konto' using errcode = '22023'; end if;
  if exists (select 1 from myc_circles where room = rm and lower(name) = lower(n)) then raise exception 'myc: nazwa zajęta' using errcode = '23505'; end if;
  insert into myc_circles (room, name, about, owner_account, max_size) values (rm, n, left(nullif(btrim(coalesce(p_about, '')), ''), 200), acc, least(greatest(coalesce(p_max, 30), 2), 200))
    returning id into cid;
  insert into myc_circle_members (circle_id, account_id, role) values (cid, acc, 'owner');
  perform myc_circle_logit(cid, acc, 'create', acc, jsonb_build_object('name', n));
  return jsonb_build_object('id', cid, 'invite', myc_circle_new_invite(cid));
end $$;

create or replace function public.myc_circle_join(p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare acc uuid := myc_acct_id(); c myc_circles;
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: najpierw załóż konto' using errcode = '42501'; end if;
  perform myc_rl('circle_join:' || myc_ip(), 6);
  select * into c from myc_circles where invite_hash = encode(digest(upper(btrim(coalesce(p_code, ''))), 'sha256'), 'hex');
  if c.id is null then raise exception 'myc: zły kod zaproszenia' using errcode = '28000'; end if;
  if c.room <> (select room from myc_accounts where id = acc) then raise exception 'myc: zły kod zaproszenia' using errcode = '28000'; end if;
  if c.frozen then raise exception 'myc: krąg zamrożony' using errcode = '42501'; end if;
  if exists (select 1 from myc_circle_members where circle_id = c.id and account_id = acc) then return jsonb_build_object('id', c.id, 'already', true); end if;
  if (select count(*) from myc_circle_members where circle_id = c.id) >= c.max_size then raise exception 'myc: krąg pełny' using errcode = '22023'; end if;
  if (select count(*) from myc_circle_members where account_id = acc) >= 10 then raise exception 'myc: maks. 10 kręgów na konto' using errcode = '22023'; end if;
  insert into myc_circle_members (circle_id, account_id) values (c.id, acc);
  perform myc_circle_logit(c.id, acc, 'join', acc);
  return jsonb_build_object('id', c.id, 'name', c.name);
end $$;

create or replace function public.myc_circle_leave(p_circle bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); r text;
begin
  perform myc_acct_uid();
  select role into r from myc_circle_members where circle_id = p_circle and account_id = acc;
  if r is null then return jsonb_build_object('ok', true); end if;
  if r = 'owner' then
    if (select count(*) from myc_circle_members where circle_id = p_circle) > 1 then
      raise exception 'myc: właściciel – najpierw przekaż krąg (admin → właściciel) albo zostań sam' using errcode = '22023';
    end if;
    delete from myc_circles where id = p_circle;   -- ostatnia osoba: krąg znika (poręczenia zostają i rozlicza je cron)
    return jsonb_build_object('ok', true, 'deleted', true);
  end if;
  delete from myc_circle_members where circle_id = p_circle and account_id = acc;
  perform myc_circle_logit(p_circle, acc, 'leave', acc);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.myc_circle_mine() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id();
begin
  perform myc_acct_uid();
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'about', c.about, 'role', m.role, 'frozen', c.frozen,
      'frozen_reason', c.frozen_reason, 'spec', c.spec, 'max_size', c.max_size,
      'members', (select count(*) from myc_circle_members x where x.circle_id = c.id), 'created_at', c.created_at) order by c.created_at)
    from myc_circle_members m join myc_circles c on c.id = m.circle_id where m.account_id = acc), '[]');
end $$;

-- Szczegóły kręgu – tylko dla członków (Developer: także dla zamrażania)
create or replace function public.myc_circle_get(p_circle bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); c myc_circles; dev boolean := coalesce(myc_role_of(myc_acct_id()) = 'developer', false);
begin
  perform myc_acct_uid();
  select * into c from myc_circles where id = p_circle;
  if c.id is null or acc is null or not (coalesce(myc_circle_is_member(p_circle), false) or dev) then raise exception 'myc: tylko dla członków kręgu' using errcode = '42501'; end if;
  return jsonb_build_object('id', c.id, 'name', c.name, 'about', c.about, 'frozen', c.frozen, 'frozen_reason', c.frozen_reason, 'spec', c.spec,
    'max_size', c.max_size, 'invite_at', c.invite_at, 'me', acc, 'my_role', (select role from myc_circle_members where circle_id = c.id and account_id = acc),
    'members', coalesce((select jsonb_agg(jsonb_build_object('handle', a.handle, 'role', m.role, 'joined_at', m.joined_at, 'trust', myc_trust(a.id),
        'new', a.created_at > now() - interval '7 days', 'me', a.id = acc,
        'vouched_by', (select va.handle from myc_vouches v join myc_accounts va on va.id = v.voucher where v.newcomer = a.id and v.circle_id = c.id and v.status = 'active'))
        order by m.role, m.joined_at) from myc_circle_members m join myc_accounts a on a.id = m.account_id where m.circle_id = c.id), '[]'),
    'vouches', coalesce((select jsonb_agg(jsonb_build_object('voucher', va.handle, 'newcomer', na.handle, 'stake', v.stake, 'status', v.status, 'at', v.created_at, 'decided_at', v.decided_at, 'reason', v.reason) order by v.created_at desc)
        from myc_vouches v join myc_accounts va on va.id = v.voucher join myc_accounts na on na.id = v.newcomer where v.circle_id = c.id), '[]'),
    'log', coalesce((select jsonb_agg(x) from (select jsonb_build_object('at', l.at, 'actor', a.handle, 'action', l.action, 'target', t.handle, 'detail', l.detail) x
        from myc_circle_log l left join myc_accounts a on a.id = l.actor left join myc_accounts t on t.id = l.target where l.circle_id = c.id order by l.at desc limit 40) y), '[]'));
end $$;

-- Zarządzanie: właściciel/admin (promote, demote, kick, rotate_invite, set_max, set_about, set_spec, make_owner);
-- Developer dodatkowo: freeze / unfreeze / slash_vouch (i wszystko powyżej).
create or replace function public.myc_circle_admin(p_circle bigint, p_action text, p_handle text default null, p_value text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); my text; dev boolean; c myc_circles; tgt uuid; trole text; out_ jsonb := jsonb_build_object('ok', true);
begin
  perform myc_acct_uid();
  perform myc_rl('circle_admin:' || acc, 30);
  select * into c from myc_circles where id = p_circle for update;
  if c.id is null then raise exception 'myc: brak kręgu' using errcode = '22023'; end if;
  my := (select role from myc_circle_members where circle_id = c.id and account_id = acc);
  if acc is null then raise exception 'myc: brak konta' using errcode = '42501'; end if;
  dev := coalesce(myc_role_of(acc) = 'developer', false);
  if p_handle is not null then
    select a.id, m.role into tgt, trole from myc_accounts a join myc_circle_members m on m.account_id = a.id and m.circle_id = c.id
     where a.room = c.room and lower(a.handle) = lower(btrim(p_handle));
    if tgt is null then raise exception 'myc: nie ma takiej osoby w kręgu' using errcode = '22023'; end if;
  end if;
  if p_action in ('freeze', 'unfreeze', 'slash_vouch') then
    if not dev then raise exception 'myc: tylko Developer' using errcode = '42501'; end if;
  elsif not (dev or coalesce(my in ('owner', 'admin'), false)) then raise exception 'myc: tylko właściciel/admin kręgu' using errcode = '42501';
  elsif c.frozen and not dev then raise exception 'myc: krąg zamrożony' using errcode = '42501';
  end if;
  if my = 'admin' and not dev and (coalesce(trole in ('owner', 'admin') and tgt <> acc, false) or p_action in ('make_owner', 'set_max')) then
    raise exception 'myc: tylko właściciel kręgu' using errcode = '42501';
  end if;
  case p_action
    when 'promote' then update myc_circle_members set role = 'admin' where circle_id = c.id and account_id = tgt and role = 'member';
    when 'demote' then update myc_circle_members set role = 'member' where circle_id = c.id and account_id = tgt and role = 'admin';
    when 'kick' then
      if trole = 'owner' then raise exception 'myc: nie można usunąć właściciela' using errcode = '22023'; end if;
      delete from myc_circle_members where circle_id = c.id and account_id = tgt;
    when 'make_owner' then
      if tgt is null then raise exception 'myc: komu?' using errcode = '22023'; end if;
      update myc_circle_members set role = 'admin' where circle_id = c.id and role = 'owner';
      update myc_circle_members set role = 'owner' where circle_id = c.id and account_id = tgt;
      update myc_circles set owner_account = tgt where id = c.id;
    when 'rotate_invite' then out_ := out_ || jsonb_build_object('invite', myc_circle_new_invite(c.id));
    when 'set_max' then update myc_circles set max_size = least(greatest(coalesce(p_value::int, 30), greatest(2, (select count(*) from myc_circle_members where circle_id = c.id)::int)), 200) where id = c.id;
    when 'set_about' then update myc_circles set about = left(nullif(btrim(coalesce(p_value, '')), ''), 200) where id = c.id;
    when 'set_spec' then
      if p_value is not null and p_value not in ('jezyk', 'obrazy', 'logika', 'zrodla') then raise exception 'myc: specjalizacja?' using errcode = '22023'; end if;
      update myc_circles set spec = p_value where id = c.id;
    when 'freeze' then update myc_circles set frozen = true, frozen_reason = left(nullif(btrim(coalesce(p_value, '')), ''), 200) where id = c.id;
    when 'unfreeze' then update myc_circles set frozen = false, frozen_reason = null where id = c.id;
    when 'slash_vouch' then
      if tgt is null then raise exception 'myc: czyje poręczenie (pseudonim nowicjusza)?' using errcode = '22023'; end if;
      update myc_vouches set status = 'slashed', decided_at = now(), reason = left(coalesce(p_value, 'Developer: oszustwo'), 200)
       where newcomer = tgt and circle_id = c.id and status = 'active';
    else raise exception 'myc: nieznana akcja' using errcode = '22023';
  end case;
  perform myc_circle_logit(c.id, acc, p_action, tgt, jsonb_strip_nulls(jsonb_build_object('value', case when p_action in ('set_max', 'set_spec', 'freeze', 'slash_vouch') then p_value end, 'by', case when dev and my is null then 'developer' end)));
  if p_action in ('freeze', 'unfreeze', 'slash_vouch') then
    insert into myc_mod_log (room, actor, actor_role, action, target, detail) values (c.room, acc, 'developer', 'circle_' || p_action, tgt, jsonb_build_object('circle', c.id));
  end if;
  return out_;
end $$;

-- Poręczenie: zaufany członek (≥ 0,35, konto ≥ 14 dni, maks. 3 aktywne) stawia 0,02–0,2 swojego zaufania za nowicjusza
-- tego kręgu (dołączył < 30 dni temu, jedno aktywne poręczenie). Wycofać się nie można – rozlicza myc_vouch_settle.
create or replace function public.myc_circle_vouch(p_circle bigint, p_handle text, p_stake real default 0.1) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); c myc_circles; tgt uuid; tj timestamptz; tr real; st real := coalesce(p_stake, 0.1); vid bigint;
begin
  perform myc_acct_uid();
  perform myc_rl('vouch:' || acc, 5);
  select * into c from myc_circles where id = p_circle;
  if c.id is null or acc is null or not coalesce(myc_circle_is_member(p_circle), false) then raise exception 'myc: tylko dla członków kręgu' using errcode = '42501'; end if;
  if c.frozen then raise exception 'myc: krąg zamrożony' using errcode = '42501'; end if;
  select a.id, m.joined_at into tgt, tj from myc_accounts a join myc_circle_members m on m.account_id = a.id and m.circle_id = c.id
   where a.room = c.room and lower(a.handle) = lower(btrim(coalesce(p_handle, '')));
  if tgt is null then raise exception 'myc: tej osoby nie ma w kręgu' using errcode = '22023'; end if;
  if tgt = acc then raise exception 'myc: nie za siebie' using errcode = '22023'; end if;
  if tj < now() - interval '30 days' then raise exception 'myc: poręczyć można tylko nowicjusza (< 30 dni w kręgu)' using errcode = '22023'; end if;
  if c.room = 'main' and (select created_at from myc_accounts where id = acc) > now() - interval '14 days' then
    raise exception 'myc: poręczać można po 14 dniach od założenia konta' using errcode = '22023'; end if;
  if (select count(*) from myc_vouches where voucher = acc and status = 'active') >= 3 then raise exception 'myc: maks. 3 aktywne poręczenia' using errcode = '22023'; end if;
  if exists (select 1 from myc_vouches where newcomer = tgt and status = 'active') then raise exception 'myc: ta osoba ma już poręczenie' using errcode = '23505'; end if;
  tr := myc_trust(acc);
  if tr < 0.35 then raise exception 'myc: za małe zaufanie do poręczania (masz %, potrzeba 0,35)', round(tr::numeric, 2) using errcode = '22023'; end if;
  st := least(greatest(st, 0.02), 0.2, tr / 3);
  insert into myc_vouches (circle_id, voucher, newcomer, stake) values (c.id, acc, tgt, st) returning id into vid;
  perform myc_circle_logit(c.id, acc, 'vouch', tgt, jsonb_build_object('stake', st));
  return jsonb_build_object('ok', true, 'id', vid, 'stake', st);
end $$;

-- Rozliczenie poręczeń (pg_cron co godzinę): ZWROT stawki, gdy nowicjusz po ≥ 14 dniach ma własne zaufanie ≥ 0,3 bez kar;
-- UTRATA (slashed), gdy nowicjusz oszukiwał: ban w czacie, ≥ 5 odrzuconych punktów i > 50% odrzuceń,
-- albo ≥ 6 głosów sprzecznych z decyzją właścicielki i > 50% błędnych.
create or replace function public.myc_vouch_settle() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v record; t jsonb; nr int := 0; ns int := 0; why text;
begin
  for v in select * from myc_vouches where status = 'active' loop
    t := myc_trust_calc(v.newcomer);
    why := case
      when exists (select 1 from myc_gchat_sanctions s where s.account_id = v.newcomer and s.banned) then 'ban w czacie'
      when (t ->> 'rejected')::real >= 5 and (t ->> 'rejected')::real > (t ->> 'approved')::real then 'odrzucony wkład > 50%'
      when (t ->> 'wrong_votes')::int >= 6 and (t ->> 'wrong_votes')::int > (t ->> 'right_votes')::int then 'kłamliwe głosy > 50%'
    end;
    if why is not null then
      update myc_vouches set status = 'slashed', decided_at = now(), reason = why where id = v.id; ns := ns + 1;
      if v.circle_id is not null then perform myc_circle_logit(v.circle_id, null, 'vouch_slashed', v.newcomer, jsonb_build_object('reason', why, 'stake', v.stake)); end if;
    elsif v.created_at < now() - interval '14 days' and (t ->> 'base')::real >= 0.3 and (t ->> 'penalty')::real < 0.1 then
      update myc_vouches set status = 'released', decided_at = now(), reason = 'nowicjusz zdobył zaufanie' where id = v.id; nr := nr + 1;
      if v.circle_id is not null then perform myc_circle_logit(v.circle_id, null, 'vouch_released', v.newcomer, jsonb_build_object('stake', v.stake)); end if;
    end if;
  end loop;
  return jsonb_build_object('released', nr, 'slashed', ns);
end $$;
revoke execute on function public.myc_vouch_settle() from public, anon, authenticated;

-- Developer: przegląd kręgów (liczby, bez treści)
create or replace function public.myc_circle_all() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if myc_role_of(myc_acct_id()) is distinct from 'developer' then raise exception 'myc: tylko Developer' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'frozen', c.frozen, 'members', (select count(*) from myc_circle_members m where m.circle_id = c.id),
     'messages', (select count(*) from myc_gchat g where g.circle_id = c.id), 'created_at', c.created_at) order by c.created_at desc)
    from myc_circles c where c.room = (select room from myc_accounts where id = myc_acct_id())), '[]');
end $$;

-- Publiczne liczniki (prawdziwe)
create or replace function public.myc_circle_stats(p_room text default 'main') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('circles', (select count(*) from myc_circles where room = p_room),
    'members', (select count(distinct m.account_id) from myc_circle_members m join myc_circles c on c.id = m.circle_id where c.room = p_room),
    'vouches_active', (select count(*) from myc_vouches v join myc_circles c on c.id = v.circle_id where c.room = p_room and v.status = 'active'))
$$;

create or replace function public.myc_circle_e2e_cleanup(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if myc_key_room(p_key) is distinct from 'e2e' then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  delete from myc_circles where room = 'e2e'; get diagnostics n = row_count;
  return jsonb_build_object('circles', n);
end $$;

do $$
declare f text;
begin
  foreach f in array array['myc_trust_me()', 'myc_circle_create(text, text, integer)', 'myc_circle_join(text)', 'myc_circle_leave(bigint)',
    'myc_circle_mine()', 'myc_circle_get(bigint)', 'myc_circle_admin(bigint, text, text, text)', 'myc_circle_vouch(bigint, text, real)', 'myc_circle_all()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['myc_circle_stats(text)', 'myc_circle_e2e_cleanup(text)'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'myc_vouch_settle';
select cron.schedule('myc_vouch_settle', '23 * * * *', $$select public.myc_vouch_settle()$$);

-- Poręczenia przeżywają usunięcie kręgu (utracona stawka zostaje utracona – nie da się jej „wyczyścić” kasując krąg)
alter table public.myc_vouches alter column circle_id drop not null;
alter table public.myc_vouches drop constraint if exists myc_vouches_circle_id_fkey;
alter table public.myc_vouches add constraint myc_vouches_circle_id_fkey foreign key (circle_id) references public.myc_circles (id) on delete set null;
