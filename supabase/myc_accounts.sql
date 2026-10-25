-- Anonimowe konta Mycelium AI (24.10.2026): bez e-maila i imienia.
-- Logowanie: Supabase Auth „anonymous sign-in” (pseudonimowy auth.uid na urządzeniu).
-- Konto = pseudonim + kod polecający; urządzenia dołączane kodem odzyskiwania (w bazie tylko SHA-256).
-- Polecenia i punkty wkładu zapisuje wyłącznie serwer (funkcje SECURITY DEFINER); klient ich nie zmienia.
-- Nagrody krypto: PLANOWANE, NIEAKTYWNE – tylko publiczny adres portfela Solana (nigdy klucz/seed).

create table if not exists public.myc_accounts (
  id uuid primary key default gen_random_uuid(),
  room text not null default 'main' check (room in ('main', 'e2e')),
  handle text not null check (handle ~ '^[[:alnum:]_.-]{3,24}$'),
  ref_code text not null unique check (ref_code ~ '^[0-9a-f]{8}$'),
  contributor_id uuid unique,             -- dawny identyfikator przeglądarki (wkład sprzed kont, pod L2E)
  referred_by uuid references public.myc_accounts (id) on delete set null,
  referred_at timestamptz,
  wallet_sol text check (wallet_sol ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  wallet_at timestamptz,
  recovery_hash text unique,
  recovery_at timestamptz,
  created_at timestamptz not null default now(),
  check (referred_by is distinct from id)
);
create unique index if not exists myc_accounts_handle_uq on public.myc_accounts (room, lower(handle));
create index if not exists myc_accounts_ref_idx on public.myc_accounts (referred_by);

create table if not exists public.myc_account_devices (
  user_id uuid primary key references auth.users (id) on delete cascade,
  account_id uuid not null references public.myc_accounts (id) on delete cascade,
  via text not null check (via in ('create', 'recovery')),
  added_at timestamptz not null default now()
);
create index if not exists myc_account_devices_acc_idx on public.myc_account_devices (account_id);

create table if not exists public.myc_account_nodes (
  node_id uuid primary key,
  account_id uuid not null references public.myc_accounts (id) on delete cascade,
  linked_at timestamptz not null default now()
);
create index if not exists myc_account_nodes_acc_idx on public.myc_account_nodes (account_id);

-- Księga punktów wkładu: pending → approved/rejected po weryfikacji (bramka, niezależni weryfikatorzy, konsensus).
create table if not exists public.myc_points (
  id bigserial primary key,
  account_id uuid not null references public.myc_accounts (id) on delete cascade,
  source text not null check (source in ('compute', 'answer', 'referral')),
  ref text not null,
  points numeric(12, 3) not null check (points >= 0),
  status text not null check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (source, ref)
);
create index if not exists myc_points_acc_idx on public.myc_points (account_id, status);

alter table public.myc_accounts enable row level security;
alter table public.myc_account_devices enable row level security;
alter table public.myc_account_nodes enable row level security;
alter table public.myc_points enable row level security;
revoke all on public.myc_accounts, public.myc_account_devices, public.myc_account_nodes, public.myc_points from public, anon, authenticated;
revoke all on sequence public.myc_points_id_seq from public, anon, authenticated;

-- Konto bieżącego użytkownika (auth.uid → urządzenie → konto).
create or replace function public.myc_acct_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select account_id from myc_account_devices where user_id = auth.uid()
$$;
revoke execute on function public.myc_acct_id() from public, anon;
grant execute on function public.myc_acct_id() to authenticated;

-- Odczyt własnych wierszy (obrona w głąb; UI i tak korzysta z myc_acct_me). Hash kodu odzyskiwania niewidoczny.
grant select (id, room, handle, ref_code, contributor_id, referred_by, referred_at, wallet_sol, wallet_at, recovery_at, created_at)
  on public.myc_accounts to authenticated;
grant select on public.myc_account_nodes, public.myc_points, public.myc_account_devices to authenticated;
drop policy if exists myc_accounts_own on public.myc_accounts;
create policy myc_accounts_own on public.myc_accounts for select to authenticated using (id = public.myc_acct_id());
drop policy if exists myc_account_nodes_own on public.myc_account_nodes;
create policy myc_account_nodes_own on public.myc_account_nodes for select to authenticated using (account_id = public.myc_acct_id());
drop policy if exists myc_points_own on public.myc_points;
create policy myc_points_own on public.myc_points for select to authenticated using (account_id = public.myc_acct_id());
drop policy if exists myc_account_devices_own on public.myc_account_devices;
create policy myc_account_devices_own on public.myc_account_devices for select to authenticated using (account_id = public.myc_acct_id());

create or replace function public.myc_acct_uid() returns uuid
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'myc: zaloguj się (konto anonimowe)' using errcode = '42501'; end if;
  return auth.uid();
end $$;
revoke execute on function public.myc_acct_uid() from public, anon, authenticated;

-- Minimalny prawdziwy wkład, od którego polecenie się liczy (zatwierdzone punkty bez punktów za polecenia).
create or replace function public.myc_acct_qualified(p_acc uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(points), 0) >= 10 from myc_points where account_id = p_acc and status = 'approved' and source <> 'referral'
$$;
revoke execute on function public.myc_acct_qualified(uuid) from public, anon, authenticated;

create or replace function public.myc_acct_me() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a myc_accounts; r jsonb;
begin
  perform myc_acct_uid();
  select * into a from myc_accounts where id = myc_acct_id();
  if a.id is null then return null; end if;
  select jsonb_build_object(
    'id', a.id, 'room', a.room, 'handle', a.handle, 'ref_code', a.ref_code, 'contributor_id', a.contributor_id,
    'created_at', a.created_at, 'wallet_sol', a.wallet_sol, 'has_recovery', a.recovery_hash is not null, 'recovery_at', a.recovery_at,
    'referred_by', (select handle from myc_accounts where id = a.referred_by), 'referred_at', a.referred_at,
    'devices', (select count(*) from myc_account_devices where account_id = a.id),
    'nodes', coalesce((select jsonb_agg(node_id order by linked_at) from myc_account_nodes where account_id = a.id), '[]'),
    'points', coalesce((select jsonb_object_agg(status, s) from (select status, sum(points) s from myc_points where account_id = a.id group by status) x), '{}'),
    'points_by_source', coalesce((select jsonb_object_agg(source || ':' || status, s) from (select source, status, sum(points) s from myc_points where account_id = a.id group by 1, 2) x), '{}'),
    'referrals', (select count(*) from myc_accounts where referred_by = a.id),
    'referrals_qualified', (select count(*) from myc_accounts c where c.referred_by = a.id and myc_acct_qualified(c.id)),
    'can_refer', a.referred_by is null and a.created_at > now() - interval '30 days'
  ) into r;
  return r;
end $$;

create or replace function public.myc_acct_handle_ok(p_room text, p_handle text, p_self uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare h text := btrim(coalesce(p_handle, ''));
begin
  if h !~ '^[[:alnum:]_.-]{3,24}$' then raise exception 'myc: pseudonim 3–24 znaki: litery, cyfry, _ . -' using errcode = '22023'; end if;
  if exists (select 1 from myc_accounts where room = p_room and lower(handle) = lower(h) and id is distinct from p_self) then
    raise exception 'myc: pseudonim zajęty' using errcode = '23505';
  end if;
  return h;
end $$;
revoke execute on function public.myc_acct_handle_ok(text, text, uuid) from public, anon, authenticated;

create or replace function public.myc_acct_link_nodes(p_nodes uuid[]) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); n int;
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: brak konta' using errcode = '42501'; end if;
  perform myc_rl('acct_nodes:' || acc, 10);
  if coalesce(cardinality(p_nodes), 0) > 20 then raise exception 'myc: maks. 20 węzłów naraz' using errcode = '22023'; end if;
  if (select count(*) from myc_account_nodes where account_id = acc) + coalesce(cardinality(p_nodes), 0) > 200 then
    raise exception 'myc: za dużo węzłów na koncie' using errcode = '22023';
  end if;
  insert into myc_account_nodes (node_id, account_id) select distinct x, acc from unnest(p_nodes) x where x is not null
    on conflict (node_id) do nothing;   -- węzeł przypisany wcześniej do innego konta zostaje przy nim
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.myc_acct_refer(p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a myc_accounts; ref myc_accounts; cur uuid; i int := 0;
begin
  perform myc_acct_uid();
  select * into a from myc_accounts where id = myc_acct_id() for update;
  if a.id is null then raise exception 'myc: brak konta' using errcode = '42501'; end if;
  perform myc_rl('acct_refer:' || a.id, 5);
  if a.referred_by is not null then raise exception 'myc: polecenie już zapisane (jedno na konto)' using errcode = '23505'; end if;
  if a.created_at < now() - interval '30 days' then raise exception 'myc: polecenie można dodać w ciągu 30 dni od założenia konta' using errcode = '22023'; end if;
  select * into ref from myc_accounts where ref_code = lower(btrim(coalesce(p_code, ''))) and room = a.room;
  if ref.id is null then raise exception 'myc: nie ma takiego kodu' using errcode = 'P0002'; end if;
  if ref.id = a.id then raise exception 'myc: nie można polecić samego siebie' using errcode = '22023'; end if;
  if exists (select 1 from myc_account_devices d1 join myc_account_devices d2 on d2.account_id = ref.id where d1.account_id = a.id and d1.user_id = d2.user_id) then
    raise exception 'myc: to samo urządzenie' using errcode = '22023';
  end if;
  cur := ref.referred_by;   -- bez pętli: polecający nie może być (pośrednio) polecony przez Ciebie
  while cur is not null and i < 100 loop
    if cur = a.id then raise exception 'myc: pętla poleceń' using errcode = '22023'; end if;
    select referred_by into cur from myc_accounts where id = cur; i := i + 1;
  end loop;
  update myc_accounts set referred_by = ref.id, referred_at = now() where id = a.id;
  return myc_acct_me();
end $$;

-- Zakłada konto dla bieżącego urządzenia (idempotentnie) i łączy dawne identyfikatory przeglądarki.
create or replace function public.myc_acct_create(p_handle text, p_contrib uuid default null, p_nodes uuid[] default '{}',
  p_ref text default null, p_room text default 'main') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := myc_acct_uid(); acc uuid; h text; code text; room text := coalesce(p_room, 'main');
begin
  if myc_acct_id() is not null then return myc_acct_me(); end if;
  if room not in ('main', 'e2e') then raise exception 'myc: zły pokój' using errcode = '22023'; end if;
  perform myc_rl('acct_create:' || myc_ip(), 5);
  h := myc_acct_handle_ok(room, p_handle, null);
  if p_contrib is not null and exists (select 1 from myc_accounts where contributor_id = p_contrib) then p_contrib := null; end if;
  code := case when p_contrib is not null then left(replace(p_contrib::text, '-', ''), 8) end;
  if code is null or exists (select 1 from myc_accounts where ref_code = code) then
    loop
      code := encode(extensions.gen_random_bytes(4), 'hex');
      exit when not exists (select 1 from myc_accounts where ref_code = code);
    end loop;
  end if;
  insert into myc_accounts (room, handle, ref_code, contributor_id) values (room, h, code, p_contrib) returning id into acc;
  insert into myc_account_devices (user_id, account_id, via) values (uid, acc, 'create');
  if coalesce(cardinality(p_nodes), 0) > 0 then perform myc_acct_link_nodes(p_nodes[1:20]); end if;
  if coalesce(p_ref, '') <> '' then
    begin perform myc_acct_refer(p_ref); exception when others then null; end;
  end if;
  return myc_acct_me();
end $$;

create or replace function public.myc_acct_set_handle(p_handle text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a myc_accounts;
begin
  perform myc_acct_uid();
  select * into a from myc_accounts where id = myc_acct_id();
  if a.id is null then raise exception 'myc: brak konta' using errcode = '42501'; end if;
  perform myc_rl('acct_handle:' || a.id, 5);
  update myc_accounts set handle = myc_acct_handle_ok(a.room, p_handle, a.id) where id = a.id;
  return myc_acct_me();
end $$;

-- Nowy kod odzyskiwania: ~120 bitów losowości z serwera, pokazany raz; w bazie tylko SHA-256. Stary przestaje działać.
create or replace function public.myc_acct_recovery_new() returns text
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare acc uuid := myc_acct_id(); raw text; code text;
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: brak konta' using errcode = '42501'; end if;
  perform myc_rl('acct_recnew:' || acc, 3);
  raw := upper(translate(encode(gen_random_bytes(18), 'base64'), '+/=0O1IL', 'XYZ89KMN'));
  code := 'MYC-' || substr(raw, 1, 6) || '-' || substr(raw, 7, 6) || '-' || substr(raw, 13, 6) || '-' || substr(raw, 19, 6);
  update myc_accounts set recovery_hash = encode(digest(code, 'sha256'), 'hex'), recovery_at = now() where id = acc;
  return code;
end $$;

-- Dołącza bieżące urządzenie do konta po kodzie odzyskiwania (limit prób na minutę i na IP).
create or replace function public.myc_acct_recover(p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := myc_acct_uid(); acc uuid;
begin
  perform myc_rl('acct_recover:' || myc_ip(), 5);
  if myc_acct_id() is not null then raise exception 'myc: to urządzenie ma już konto – najpierw się wyloguj' using errcode = '23505'; end if;
  select id into acc from myc_accounts where recovery_hash = encode(digest(upper(btrim(coalesce(p_code, ''))), 'sha256'), 'hex');
  if acc is null then raise exception 'myc: zły kod' using errcode = '28000'; end if;
  if (select count(*) from myc_account_devices where account_id = acc) >= 20 then raise exception 'myc: za dużo urządzeń' using errcode = '22023'; end if;
  insert into myc_account_devices (user_id, account_id, via) values (uid, acc, 'recovery');
  return myc_acct_me();
end $$;

-- Publiczny adres portfela Solana (tylko adres!). Nagrody: planowane, nieaktywne.
create or replace function public.myc_acct_set_wallet(p_addr text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); w text := nullif(btrim(coalesce(p_addr, '')), '');
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: brak konta' using errcode = '42501'; end if;
  perform myc_rl('acct_wallet:' || acc, 5);
  if w is not null and w !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    raise exception 'myc: to nie jest publiczny adres Solana (32–44 znaki base58). Nigdy nie podawaj klucza prywatnego ani frazy seed.' using errcode = '22023';
  end if;
  update myc_accounts set wallet_sol = w, wallet_at = case when w is null then null else now() end where id = acc;
  return myc_acct_me();
end $$;

-- Odłącza bieżące urządzenie (wylogowanie). Ostatniego urządzenia bez kodu odzyskiwania nie odłączamy.
create or replace function public.myc_acct_forget_device(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := myc_acct_uid(); acc uuid := myc_acct_id();
begin
  if acc is null then return jsonb_build_object('ok', true); end if;
  if not p_force and (select count(*) from myc_account_devices where account_id = acc) = 1
     and (select recovery_hash is null from myc_accounts where id = acc) then
    raise exception 'myc: to jedyne urządzenie i brak kodu odzyskiwania – utworzysz kod przed wylogowaniem?' using errcode = 'P0001';
  end if;
  delete from myc_account_devices where user_id = uid;
  return jsonb_build_object('ok', true);
end $$;

-- Księgowanie punktów z prawdziwych wyników (pg_cron co 10 min). Atrybucja: węzły przypisane do konta
-- lub dawny contributor_id konta. Wynik 'accepted' (bramka/weryfikacja) → approved, 'rejected' → rejected, reszta pending.
create or replace function public.myc_points_sync() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n1 int; n2 int; n3 int;
begin
  insert into myc_points (account_id, source, ref, points, status, decided_at)
  select acc, 'compute', 'r' || r.id, 1, st, case when st <> 'pending' then now() end
  from (
    select r.id, coalesce(an.account_id, ac.id) acc,
           case r.status when 'accepted' then 'approved' when 'rejected' then 'rejected' else 'pending' end st
    from myc_results r
    left join myc_account_nodes an on an.node_id = r.node_id
    left join myc_accounts ac on ac.contributor_id = r.contributor_id
    where r.kind in ('train', 'hparam') and r.status in ('accepted', 'rejected', 'pending')
  ) r where acc is not null
  on conflict (source, ref) do update set status = excluded.status, decided_at = excluded.decided_at
    where myc_points.status = 'pending' and excluded.status <> 'pending';
  get diagnostics n1 = row_count;

  insert into myc_points (account_id, source, ref, points, status, decided_at)
  select acc, 'answer', 'a' || c.answer_id, 0.1, st, case when st <> 'pending' then now() end
  from (
    select c.answer_id, coalesce(an.account_id, ac.id) acc,
           case c.status when 'approved' then 'approved' when 'rejected' then 'rejected' else 'pending' end st
    from myc_contributions c
    left join myc_account_nodes an on an.node_id = c.node_id
    left join myc_accounts ac on ac.contributor_id = c.contributor_id
  ) c where acc is not null
  on conflict (source, ref) do update set status = excluded.status, decided_at = excluded.decided_at
    where myc_points.status = 'pending' and excluded.status <> 'pending';
  get diagnostics n2 = row_count;

  -- polecenie liczy się dopiero, gdy polecona osoba ma ≥ 10 zatwierdzonych punktów własnego wkładu
  insert into myc_points (account_id, source, ref, points, status, decided_at)
  select c.referred_by, 'referral', 'ref:' || c.id, 5, 'approved', now()
  from myc_accounts c where c.referred_by is not null and myc_acct_qualified(c.id)
  on conflict (source, ref) do nothing;
  get diagnostics n3 = row_count;
  return jsonb_build_object('compute', n1, 'answer', n2, 'referral', n3);
end $$;
revoke execute on function public.myc_points_sync() from public, anon, authenticated;

-- Sprzątanie testów e2e: konta z pokoju 'e2e', tylko kluczem pokoju e2e. Osieroconych anonimowych
-- użytkowników auth (po teście, wylogowaniu albo nieudanym założeniu konta) usuwa myc_auth_purge (pg_cron).
create or replace function public.myc_acct_e2e_cleanup(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if myc_key_room(p_key) is distinct from 'e2e' then raise exception 'myc: brak uprawnień' using errcode = '42501'; end if;
  delete from myc_accounts where room = 'e2e'; get diagnostics n = row_count;
  return jsonb_build_object('accounts', n);
end $$;

create or replace function public.myc_auth_purge() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  delete from auth.users u where u.is_anonymous and u.created_at < now() - interval '1 day'
    and not exists (select 1 from myc_account_devices d where d.user_id = u.id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.myc_auth_purge() from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array['myc_acct_me()', 'myc_acct_link_nodes(uuid[])', 'myc_acct_refer(text)',
    'myc_acct_create(text, uuid, uuid[], text, text)', 'myc_acct_set_handle(text)', 'myc_acct_recovery_new()',
    'myc_acct_recover(text)', 'myc_acct_set_wallet(text)', 'myc_acct_forget_device(boolean)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.myc_acct_e2e_cleanup(text) from public;
grant execute on function public.myc_acct_e2e_cleanup(text) to anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'myc_points_sync';
select cron.schedule('myc_points_sync', '*/10 * * * *', $$select public.myc_points_sync()$$);
select cron.unschedule(jobid) from cron.job where jobname = 'myc_auth_purge';
select cron.schedule('myc_auth_purge', '17 * * * *', $$select public.myc_auth_purge()$$);
