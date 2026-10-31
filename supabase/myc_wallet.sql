-- Mycelium Wallet i testowy token MYC-test (1.11.2026). Szczegóły i model zagrożeń: docs/wallet.md.
--
-- MYC-test to TOKENY TESTOWE BEZ ŻADNEJ WARTOŚCI: nie da się ich kupić, sprzedać ani wypłacić; nie ma żadnej
-- ścieżki wymiany na pieniądze. Służą do nauki i testów sieci (napiwki, przelewy, walidacja bloków przez węzły).
--
-- • Klucz prywatny Ed25519 powstaje i zostaje w przeglądarce (zaszyfrowany hasłem w IndexedDB). Baza zna tylko klucz publiczny.
-- • Emisja tylko według reguł, każda z prawdziwym identyfikatorem zdarzenia (unikalny memo 'faucet:…' / 'reward:…').
-- • Przelew podpisuje klient: MYC-TEST/v1|transfer|from|to|amount|nonce|ts_ms|memo. Serwer sprawdza podpis (pgsodium,
--   Ed25519), nonce = poprzedni + 1 (powtórka/podwójne wydanie odrzucone), saldo pod blokadą wiersza.
-- • Księga tylko do dopisywania, z łańcuchem skrótów: hash = sha256(prev_hash|body|sig).
-- • Co minutę oczekujące transakcje trafiają do bloku (korzeń Merkle). Węzły niezależnie sprawdzają każdy podpis,
--   łańcuch, salda, korzeń i skrót bloku, dokładają mały dowód pracy i podpisują wynik kluczem węzła. Blok jest
--   ostateczny, gdy ≥ 2 różne uprawnione węzły (≥ 3 przyjęte wyniki treningu AI) poświadczą ten sam skrót.
-- Kwoty w jednostkach 1/100 MYC-test (1000 = 10,00 MYC-test).

create extension if not exists pgsodium;

create table if not exists public.myc_wallets (
  pub text primary key check (pub ~ '^[0-9a-f]{64}$'),
  account_id uuid references public.myc_accounts (id) on delete set null,
  room text not null check (room in ('main', 'e2e')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists myc_wallets_acc_active on public.myc_wallets (account_id) where active;

create table if not exists public.myc_wallet_bal (
  pub text primary key references public.myc_wallets (pub),
  balance bigint not null default 0 check (balance >= 0),
  nonce bigint not null default 0 check (nonce >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.myc_wallet_head (
  id int primary key check (id = 1),
  last_id bigint not null,
  last_hash text not null,
  height int not null,
  block_hash text not null
);
insert into public.myc_wallet_head values (1, 0, repeat('0', 64), 0, repeat('0', 64)) on conflict do nothing;

create table if not exists public.myc_wallet_tx (
  id bigint primary key,
  kind text not null check (kind in ('mint', 'transfer')),
  from_pub text check (from_pub ~ '^[0-9a-f]{64}$'),
  to_pub text not null check (to_pub ~ '^[0-9a-f]{64}$'),
  amount bigint not null check (amount between 1 and 1000000000),
  nonce bigint not null check (nonce >= 0),
  ts_ms bigint not null,
  memo text not null default '' check (char_length(memo) <= 80),
  sig text not null default '' check (sig = '' or sig ~ '^[0-9a-f]{128}$'),
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  block int,
  created_at timestamptz not null default now(),
  check ((kind = 'mint') = (from_pub is null)),
  check (kind = 'mint' or sig <> '')
);
create unique index if not exists myc_wallet_tx_mint_ref on public.myc_wallet_tx (memo) where kind = 'mint';
create index if not exists myc_wallet_tx_from on public.myc_wallet_tx (from_pub, id desc);
create index if not exists myc_wallet_tx_to on public.myc_wallet_tx (to_pub, id desc);
create index if not exists myc_wallet_tx_pending on public.myc_wallet_tx (id) where block is null;
create index if not exists myc_wallet_tx_block on public.myc_wallet_tx (block);

create table if not exists public.myc_wallet_blocks (
  height int primary key,
  prev_hash text not null,
  merkle_root text not null,
  first_id bigint not null,
  last_id bigint not null,
  n_tx int not null,
  last_tx_hash text not null,
  created_ms bigint not null,
  hash text not null unique,
  pow_bits smallint not null default 16,
  final_at timestamptz,
  disputed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists myc_wallet_blocks_open on public.myc_wallet_blocks (height) where final_at is null;

create table if not exists public.myc_node_keys (
  node_id uuid primary key,
  pub text not null unique check (pub ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.myc_wallet_attest (
  height int not null references public.myc_wallet_blocks (height) on delete cascade,
  node_id uuid not null,
  ok boolean not null,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  matches boolean not null,
  reason text not null default '' check (char_length(reason) <= 120),
  pow_nonce bigint not null,
  sig text not null check (sig ~ '^[0-9a-f]{128}$'),
  n_tx int not null check (n_tx between 0 and 100000),
  n_sig int not null default 0 check (n_sig between 0 and 100000),
  ms int not null check (ms between 0 and 3600000),
  backend text not null check (backend in ('cpu', 'wasm', 'webgpu', 'directml', 'cuda')),
  eligible boolean not null,
  created_at timestamptz not null default now(),
  primary key (height, node_id)
);
create index if not exists myc_wallet_attest_at on public.myc_wallet_attest (created_at desc);

create table if not exists public.myc_wallet_faucet (
  account_id uuid not null,
  day date not null,
  ip text not null,
  at timestamptz not null default now(),
  primary key (account_id, day)
);
create index if not exists myc_wallet_faucet_ip on public.myc_wallet_faucet (ip, day);

alter table public.myc_wallets enable row level security;
alter table public.myc_wallet_bal enable row level security;
alter table public.myc_wallet_head enable row level security;
alter table public.myc_wallet_tx enable row level security;
alter table public.myc_wallet_blocks enable row level security;
alter table public.myc_node_keys enable row level security;
alter table public.myc_wallet_attest enable row level security;
alter table public.myc_wallet_faucet enable row level security;
revoke all on public.myc_wallets, public.myc_wallet_bal, public.myc_wallet_head, public.myc_wallet_tx, public.myc_wallet_blocks,
  public.myc_node_keys, public.myc_wallet_attest, public.myc_wallet_faucet from public, anon, authenticated;
-- publiczny odczyt księgi (eksplorator, węzły); konto właściciela adresu i IP z kranu nie są publiczne
grant select (pub, room, active, created_at) on public.myc_wallets to anon, authenticated;
grant select on public.myc_wallet_bal, public.myc_wallet_head, public.myc_wallet_tx, public.myc_wallet_blocks, public.myc_node_keys,
  public.myc_wallet_attest to anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['myc_wallets', 'myc_wallet_bal', 'myc_wallet_head', 'myc_wallet_tx', 'myc_wallet_blocks', 'myc_node_keys', 'myc_wallet_attest'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (true)', t || '_read', t);
  end loop;
end $$;

-- Księga tylko do dopisywania: wiersz transakcji można zmienić jedynie przez przypisanie do bloku (raz).
create or replace function public.myc_wallet_tx_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'myc: księga MYC-test jest tylko do dopisywania' using errcode = '42501';
  end if;
  if (old.id, old.kind, old.from_pub, old.to_pub, old.amount, old.nonce, old.ts_ms, old.memo, old.sig, old.prev_hash, old.hash)
     is distinct from (new.id, new.kind, new.from_pub, new.to_pub, new.amount, new.nonce, new.ts_ms, new.memo, new.sig, new.prev_hash, new.hash)
     or (old.block is not null and old.block is distinct from new.block) then
    raise exception 'myc: księga MYC-test jest tylko do dopisywania' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists myc_wallet_tx_guard on public.myc_wallet_tx;
create trigger myc_wallet_tx_guard before update or delete on public.myc_wallet_tx for each row execute function public.myc_wallet_tx_guard();
create or replace function public.myc_wallet_block_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' or (old.height, old.prev_hash, old.merkle_root, old.first_id, old.last_id, old.n_tx, old.last_tx_hash, old.created_ms, old.hash)
     is distinct from (new.height, new.prev_hash, new.merkle_root, new.first_id, new.last_id, new.n_tx, new.last_tx_hash, new.created_ms, new.hash) then
    raise exception 'myc: bloki MYC-test są tylko do dopisywania' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists myc_wallet_block_guard on public.myc_wallet_blocks;
create trigger myc_wallet_block_guard before update or delete on public.myc_wallet_blocks for each row execute function public.myc_wallet_block_guard();

-- ------------------------------------------------------------------ prymitywy
create or replace function public.myc_wallet_sha(p text) returns text
language sql immutable set search_path = public, extensions, pg_temp as $$
  select encode(extensions.digest(convert_to(p, 'UTF8'), 'sha256'), 'hex')
$$;
create or replace function public.myc_wallet_verify(p_pub text, p_msg text, p_sig text) returns boolean
language plpgsql immutable security definer set search_path = public, pg_temp as $$
begin
  if p_pub !~ '^[0-9a-f]{64}$' or p_sig !~ '^[0-9a-f]{128}$' then return false; end if;
  return pgsodium.crypto_sign_verify_detached(decode(p_sig, 'hex'), convert_to(p_msg, 'UTF8'), decode(p_pub, 'hex'));
exception when others then
  return false;
end $$;
-- treść podpisywana / haszowana (ta sama w przeglądarce: web/src/myc/wallet.ts i w węźle: mesh/walletwork.py)
create or replace function public.myc_wallet_body(p_kind text, p_from text, p_to text, p_amount bigint, p_nonce bigint, p_ts bigint, p_memo text)
returns text language sql immutable as $$
  select concat_ws('|', 'MYC-TEST/v1', p_kind, coalesce(p_from, ''), p_to, p_amount::text, p_nonce::text, p_ts::text, coalesce(p_memo, ''))
$$;
create or replace function public.myc_wallet_now_ms() returns bigint
language sql stable as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;
revoke all on function public.myc_wallet_verify(text, text, text) from public, anon, authenticated;
revoke all on function public.myc_wallet_sha(text), public.myc_wallet_body(text, text, text, bigint, bigint, bigint, text),
  public.myc_wallet_now_ms() from public, anon, authenticated;

-- limit wielkości księgi (baza darmowa 500 MB): po przekroczeniu emisja i przelewy stoją, odczyt działa
create or replace function public.myc_wallet_room_ok() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if (select last_id from myc_wallet_head where id = 1) >= 300000 then
    raise exception 'myc: księga MYC-test osiągnęła limit 300 000 transakcji (ochrona miejsca w bazie) – pauza' using errcode = '53400';
  end if;
end $$;
revoke all on function public.myc_wallet_room_ok() from public, anon, authenticated;

-- Dopisanie transakcji do łańcucha (wywołujący trzyma blokadę wiersza głowy).
create or replace function public.myc_wallet_append(h myc_wallet_head, p_kind text, p_from text, p_to text, p_amount bigint, p_nonce bigint,
  p_ts bigint, p_memo text, p_sig text) returns myc_wallet_tx
language plpgsql security definer set search_path = public, pg_temp as $$
declare body text := myc_wallet_body(p_kind, p_from, p_to, p_amount, p_nonce, p_ts, p_memo); t myc_wallet_tx;
begin
  insert into myc_wallet_tx (id, kind, from_pub, to_pub, amount, nonce, ts_ms, memo, sig, prev_hash, hash)
    values (h.last_id + 1, p_kind, p_from, p_to, p_amount, p_nonce, p_ts, coalesce(p_memo, ''), coalesce(p_sig, ''), h.last_hash,
            myc_wallet_sha(h.last_hash || '|' || body || '|' || coalesce(p_sig, '')))
    returning * into t;
  update myc_wallet_head set last_id = t.id, last_hash = t.hash where id = 1;
  return t;
end $$;
revoke all on function public.myc_wallet_append(myc_wallet_head, text, text, text, bigint, bigint, bigint, text, text) from public, anon, authenticated;

-- Emisja według reguły (tylko z funkcji serwera). Powtórzony identyfikator zdarzenia = nic się nie dzieje.
create or replace function public.myc_wallet_mint(p_to text, p_amount bigint, p_ref text) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare h myc_wallet_head; t myc_wallet_tx;
begin
  if p_ref !~ '^(faucet|reward):[a-z0-9:]{3,70}$' then raise exception 'myc: zły identyfikator emisji'; end if;
  perform myc_wallet_room_ok();
  select * into h from myc_wallet_head where id = 1 for update;
  if exists (select 1 from myc_wallet_tx where kind = 'mint' and memo = p_ref) then return null; end if;
  t := myc_wallet_append(h, 'mint', null, p_to, p_amount, 0, myc_wallet_now_ms(), p_ref, '');
  insert into myc_wallet_bal (pub, balance) values (p_to, p_amount)
    on conflict (pub) do update set balance = myc_wallet_bal.balance + p_amount, updated_at = now();
  return t.id;
end $$;
revoke all on function public.myc_wallet_mint(text, bigint, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ konto ↔ portfel
-- Rejestracja klucza publicznego: dowód posiadania klucza = podpis 'MYC-TEST/v1|register|<konto>|<pub>'.
-- Nowy klucz (np. po utracie urządzenia bez kopii) zastępuje aktywny; stary adres zachowuje swoje saldo.
create or replace function public.myc_wallet_register(p_pub text, p_sig text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); r text;
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: najpierw załóż konto (pseudonim)' using errcode = '42501'; end if;
  perform myc_rl('wallet_reg:' || acc, 3);
  if p_pub !~ '^[0-9a-f]{64}$' then raise exception 'myc: zły klucz publiczny' using errcode = '22023'; end if;
  if not myc_wallet_verify(p_pub, concat_ws('|', 'MYC-TEST/v1', 'register', acc::text, p_pub), p_sig) then
    raise exception 'myc: zły podpis rejestracji' using errcode = '22023';
  end if;
  if exists (select 1 from myc_wallets where pub = p_pub and account_id is distinct from acc) then
    raise exception 'myc: ten klucz należy do innego konta' using errcode = '23505';
  end if;
  if (select count(*) from myc_wallets where account_id = acc) >= 10 then raise exception 'myc: za dużo kluczy na koncie' using errcode = '22023'; end if;
  select room into r from myc_accounts where id = acc;
  update myc_wallets set active = false where account_id = acc and active and pub <> p_pub;
  insert into myc_wallets (pub, account_id, room) values (p_pub, acc, r)
    on conflict (pub) do update set active = true;
  insert into myc_wallet_bal (pub) values (p_pub) on conflict do nothing;
  return myc_wallet_me();
end $$;

create or replace function public.myc_wallet_me() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); w myc_wallets; b myc_wallet_bal; f timestamptz;
begin
  perform myc_acct_uid();
  if acc is null then return null; end if;
  select * into w from myc_wallets where account_id = acc and active;
  if w.pub is null then
    return jsonb_build_object('pub', null, 'old', coalesce((select jsonb_agg(pub) from myc_wallets where account_id = acc), '[]'));
  end if;
  select * into b from myc_wallet_bal where pub = w.pub;
  select max(at) into f from myc_wallet_faucet where account_id = acc;
  return jsonb_build_object('pub', w.pub, 'room', w.room, 'balance', coalesce(b.balance, 0), 'nonce', coalesce(b.nonce, 0),
    'pending_in', coalesce((select sum(amount) from myc_wallet_tx where to_pub = w.pub and block is null), 0),
    'faucet_next', case when f is null then null else f + interval '20 hours' end,
    'old', coalesce((select jsonb_agg(pub) from myc_wallets where account_id = acc and not active), '[]'));
end $$;

-- Kran: 10,00 MYC-test raz na 20 h na konto; maks. 3 konta z jednego adresu IP na dobę; maks. 300 wypłat dziennie łącznie.
create or replace function public.myc_wallet_faucet_claim() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid := myc_acct_id(); w text; v_ip text := myc_ip(); d date := (now() at time zone 'Europe/Amsterdam')::date; last timestamptz; id bigint;
begin
  perform myc_acct_uid();
  if acc is null then raise exception 'myc: najpierw załóż konto' using errcode = '42501'; end if;
  perform myc_rl('faucet:' || acc, 3);
  select pub into w from myc_wallets where account_id = acc and active;
  if w is null then raise exception 'myc: najpierw utwórz portfel' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('myc_faucet:' || acc));
  select max(at) into last from myc_wallet_faucet where account_id = acc;
  if last > now() - interval '20 hours' then
    raise exception 'myc: kran już użyty – następny raz po %', to_char(last + interval '20 hours' at time zone 'Europe/Amsterdam', 'DD.MM HH24:MI') using errcode = 'PT429';
  end if;
  if (select count(*) from myc_wallet_faucet where ip = v_ip and day = d) >= 3 then
    raise exception 'myc: limit kranu dla tej sieci (3 konta na dobę)' using errcode = 'PT429';
  end if;
  if (select count(*) from myc_wallet_faucet where day = d) >= 300 then
    raise exception 'myc: dzienny limit kranu dla całej sieci wyczerpany – spróbuj jutro' using errcode = 'PT429';
  end if;
  insert into myc_wallet_faucet (account_id, day, ip) values (acc, d, v_ip);
  id := myc_wallet_mint(w, 1000, 'faucet:' || replace(acc::text, '-', '') || ':' || to_char(d, 'YYYYMMDD'));
  return myc_wallet_me() || jsonb_build_object('tx', id);
end $$;

-- Adres po pseudonimie (do wysyłania na pseudonim) i pseudonim po adresie (eksplorator). Tylko aktywne portfele.
create or replace function public.myc_wallet_dir(p_handle text default null, p_pubs text[] default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('pub', w.pub, 'handle', a.handle, 'room', w.room, 'active', w.active)), '[]')
  from myc_wallets w join myc_accounts a on a.id = w.account_id
  where (p_handle is not null and w.active and lower(a.handle) = lower(btrim(p_handle)) and a.room = 'main')
     or (p_pubs is not null and w.pub = any (p_pubs[1:200]))
$$;

-- ------------------------------------------------------------------ przelew
create or replace function public.myc_wallet_send(p_from text, p_to text, p_amount bigint, p_nonce bigint, p_ts bigint, p_memo text, p_sig text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare h myc_wallet_head; b myc_wallet_bal; t myc_wallet_tx; memo text := coalesce(p_memo, '');
begin
  perform myc_rl('wallet_send:' || left(coalesce(p_from, ''), 16), 10);
  if p_from !~ '^[0-9a-f]{64}$' or p_to !~ '^[0-9a-f]{64}$' then raise exception 'myc: zły adres' using errcode = '22023'; end if;
  if p_from = p_to then raise exception 'myc: nie można wysłać do siebie' using errcode = '22023'; end if;
  if p_nonce is null or p_nonce < 1 or p_ts is null or p_sig is null then raise exception 'myc: brak pól transakcji' using errcode = '22023'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 100000000 then raise exception 'myc: zła kwota' using errcode = '22023'; end if;
  if memo !~ '^[[:alnum:] .,:!?#_+-]{0,64}$' or memo is not nfc normalized then raise exception 'myc: notatka: do 64 znaków, bez | i znaków sterujących' using errcode = '22023'; end if;
  if p_ts is null or abs(p_ts - myc_wallet_now_ms()) > 600000 then raise exception 'myc: znacznik czasu poza oknem ±10 min (zegar urządzenia?)' using errcode = '22023'; end if;
  if not myc_wallet_verify(p_from, myc_wallet_body('transfer', p_from, p_to, p_amount, p_nonce, p_ts, memo), p_sig) then
    raise exception 'myc: zły podpis' using errcode = '22023';
  end if;
  if not exists (select 1 from myc_wallets where pub = p_to) then raise exception 'myc: odbiorca nie ma portfela Mycelium' using errcode = 'P0002'; end if;
  perform myc_wallet_room_ok();
  select * into h from myc_wallet_head where id = 1 for update;      -- kolejność w łańcuchu
  select * into b from myc_wallet_bal where pub = p_from for update; -- saldo i nonce nadawcy
  if b.pub is null then raise exception 'myc: brak środków' using errcode = '22023'; end if;
  if p_nonce <> b.nonce + 1 then
    raise exception 'myc: zły nonce (oczekiwany %): powtórka albo równoległe wysłanie odrzucone', b.nonce + 1 using errcode = '40001';
  end if;
  if b.balance < p_amount then raise exception 'myc: brak środków' using errcode = '22023'; end if;
  t := myc_wallet_append(h, 'transfer', p_from, p_to, p_amount, p_nonce, p_ts, memo, p_sig);
  update myc_wallet_bal set balance = balance - p_amount, nonce = p_nonce, updated_at = now() where pub = p_from;
  insert into myc_wallet_bal (pub, balance) values (p_to, p_amount)
    on conflict (pub) do update set balance = myc_wallet_bal.balance + p_amount, updated_at = now();
  return jsonb_build_object('id', t.id, 'hash', t.hash);
end $$;

-- ------------------------------------------------------------------ bloki
create or replace function public.myc_wallet_merkle(p_hashes text[]) returns text
language plpgsql immutable set search_path = public, extensions, pg_temp as $$
declare lv bytea[]; nx bytea[]; i int; n int;
begin
  if coalesce(cardinality(p_hashes), 0) = 0 then return repeat('0', 64); end if;
  select array_agg(decode(x, 'hex') order by o) into lv from unnest(p_hashes) with ordinality u(x, o);
  while cardinality(lv) > 1 loop
    nx := '{}'; n := cardinality(lv); i := 1;
    while i <= n loop
      nx := nx || extensions.digest(lv[i] || lv[least(i + 1, n)], 'sha256');
      i := i + 2;
    end loop;
    lv := nx;
  end loop;
  return encode(lv[1], 'hex');
end $$;
revoke all on function public.myc_wallet_merkle(text[]) from public, anon, authenticated;

create or replace function public.myc_wallet_header(p_height int, p_prev text, p_root text, p_first bigint, p_last bigint, p_n int, p_last_hash text, p_ms bigint)
returns text language sql immutable as $$
  select concat_ws('|', 'MYC-TEST/v1', 'block', p_height::text, p_prev, p_root, p_first::text, p_last::text, p_n::text, p_last_hash, p_ms::text)
$$;
revoke all on function public.myc_wallet_header(int, text, text, bigint, bigint, int, text, bigint) from public, anon, authenticated;

-- pg_cron co minutę: do 1000 oczekujących transakcji → nowy blok.
create or replace function public.myc_wallet_make_block() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare h myc_wallet_head; ids bigint[]; hs text[]; root text; hd text; ms bigint := myc_wallet_now_ms(); bh text; lh text;
begin
  select * into h from myc_wallet_head where id = 1 for update;
  select array_agg(id order by id), array_agg(hash order by id) into ids, hs
    from (select id, hash from myc_wallet_tx where block is null order by id limit 1000) x;
  if ids is null then return 0; end if;
  root := myc_wallet_merkle(hs);
  lh := hs[cardinality(hs)];
  hd := myc_wallet_header(h.height + 1, h.block_hash, root, ids[1], ids[cardinality(ids)], cardinality(ids), lh, ms);
  bh := myc_wallet_sha(hd);
  insert into myc_wallet_blocks (height, prev_hash, merkle_root, first_id, last_id, n_tx, last_tx_hash, created_ms, hash, pow_bits)
    values (h.height + 1, h.block_hash, root, ids[1], ids[cardinality(ids)], cardinality(ids), lh, ms, bh, 16);
  update myc_wallet_tx set block = h.height + 1 where id = any (ids);
  update myc_wallet_head set height = h.height + 1, block_hash = bh where id = 1;
  return h.height + 1;
end $$;
revoke all on function public.myc_wallet_make_block() from public, anon, authenticated;

-- ------------------------------------------------------------------ węzły walidujące
-- Klucz węzła (Ed25519, powstaje na węźle): pierwsza rejestracja dla danego id wygrywa (TOFU, docs/wallet.md).
create or replace function public.myc_node_key_register(p_node uuid, p_pub text, p_sig text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare cur text;
begin
  perform myc_rl('nodekey:' || p_node, 3);
  if not myc_wallet_verify(p_pub, concat_ws('|', 'MYC-TEST/v1', 'nodekey', p_node::text, p_pub), p_sig) then
    raise exception 'myc: zły podpis klucza węzła' using errcode = '22023';
  end if;
  select pub into cur from myc_node_keys where node_id = p_node;
  if cur = p_pub then return true; end if;
  if cur is not null then raise exception 'myc: ten węzeł ma już inny klucz' using errcode = '23505'; end if;
  insert into myc_node_keys (node_id, pub) values (p_node, p_pub);
  return true;
end $$;

-- uprawniony walidator = węzeł z ≥ 3 przyjętymi wynikami prawdziwej pracy AI (myc_results, status accepted)
create or replace function public.myc_wallet_eligible(p_node uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*) >= 3 from (select 1 from myc_results where node_id = p_node and status = 'accepted' limit 3) x
$$;

create or replace function public.myc_wallet_try_final() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare b myc_wallet_blocks; n int := 0; k int;
begin
  for b in select * from myc_wallet_blocks where final_at is null order by height loop
    if b.height > 1 and not exists (select 1 from myc_wallet_blocks where height = b.height - 1 and final_at is not null) then exit; end if;
    if b.disputed then exit; end if;
    select count(distinct node_id) into k from myc_wallet_attest where height = b.height and ok and matches and eligible;
    if k < 2 then exit; end if;
    update myc_wallet_blocks set final_at = now() where height = b.height;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.myc_wallet_try_final() from public, anon, authenticated;

-- Poświadczenie bloku: podpis 'MYC-TEST/v1|attest|<wys>|<skrót>|<1/0>|<węzeł>|<pow>' + dowód pracy
-- sha256('<skrót>|<klucz węzła>|<pow>') z ≥ pow_bits wiodącymi zerami. Skrót niezgodny z blokiem = zapisany i oznaczony.
create or replace function public.myc_wallet_attest(p_node uuid, p_height int, p_hash text, p_ok boolean, p_reason text, p_pow bigint,
  p_n_tx int, p_n_sig int, p_ms int, p_backend text, p_sig text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text; b myc_wallet_blocks; pw text; el boolean; fin int; why text := left(coalesce(p_reason, ''), 120);
begin
  perform myc_rl('attest:' || p_node, 30);
  select pub into k from myc_node_keys where node_id = p_node;
  if k is null then raise exception 'myc: węzeł bez klucza' using errcode = '42501'; end if;
  select * into b from myc_wallet_blocks where height = p_height;
  if b.height is null then raise exception 'myc: nie ma takiego bloku' using errcode = 'P0002'; end if;
  if p_hash !~ '^[0-9a-f]{64}$' then raise exception 'myc: zły skrót' using errcode = '22023'; end if;
  if not myc_wallet_verify(k, concat_ws('|', 'MYC-TEST/v1', 'attest', p_height::text, p_hash, case when p_ok then '1' else '0' end, p_node::text, p_pow::text), p_sig) then
    raise exception 'myc: zły podpis poświadczenia' using errcode = '22023';
  end if;
  pw := myc_wallet_sha(p_hash || '|' || k || '|' || p_pow::text);
  -- 16 bitów = 4 zera szesnastkowo
  if left(pw, (b.pow_bits / 4)) <> repeat('0', b.pow_bits / 4) then raise exception 'myc: brak dowodu pracy' using errcode = '22023'; end if;
  el := myc_wallet_eligible(p_node);
  insert into myc_wallet_attest (height, node_id, ok, hash, matches, reason, pow_nonce, sig, n_tx, n_sig, ms, backend, eligible)
    values (p_height, p_node, coalesce(p_ok, false), p_hash, p_hash = b.hash, why, p_pow, p_sig, greatest(0, least(coalesce(p_n_tx, 0), 100000)),
            greatest(0, least(coalesce(p_n_sig, 0), 100000)), greatest(0, least(coalesce(p_ms, 0), 3600000)),
            case when p_backend in ('cpu', 'wasm', 'webgpu', 'directml', 'cuda') then p_backend else 'cpu' end, el)
    on conflict (height, node_id) do nothing;
  if not found then return jsonb_build_object('dup', true); end if;
  if el and not coalesce(p_ok, false) then update myc_wallet_blocks set disputed = true where height = p_height; end if;
  fin := myc_wallet_try_final();
  return jsonb_build_object('eligible', el, 'matches', p_hash = b.hash, 'finalized', fin);
end $$;

-- ------------------------------------------------------------------ nagrody za prawdziwy wkład (pg_cron co 5 min)
-- Każda nagroda ma identyfikator zdarzenia; ta sama nagroda nigdy nie powstanie dwa razy (unikalne memo emisji).
--  • reward:pt:<id>        – zatwierdzony punkt wkładu (myc_points: przyjęty wynik obliczeń, zatwierdzona odpowiedź, polecenie): 1 pkt = 1,00
--  • reward:wa/wp:<id>:<w> – głos w Weryfikuj zgodny z rozstrzygnięciem (odpowiedź czatu / rozbiór): 0,50
--  • reward:spk:<id>:<v>   – ocena wpisu Grzybni w czacie globalnym (sens): 0,10
create or replace function public.myc_wallet_rewards() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in
    select w.pub, 'reward:pt:' || p.id ref, greatest(1, round(p.points * 100))::bigint amt
      from myc_points p join myc_wallets w on w.account_id = p.account_id and w.active
     where p.status = 'approved' and not exists (select 1 from myc_wallet_tx t where t.kind = 'mint' and t.memo = 'reward:pt:' || p.id)
    union all
    select w.pub, 'reward:wa:' || v.answer_id || ':' || replace(v.voter_node::text, '-', ''), 50
      from myc_chat_answer_votes v join myc_chat_answers a on a.id = v.answer_id
      join lateral (select coalesce((select account_id from myc_account_nodes where node_id = v.voter_node),
                                    (select id from myc_accounts where contributor_id = v.contributor_id)) acc) x on true
      join myc_wallets w on w.account_id = x.acc and w.active
     where v.voter = 'person' and ((a.status = 'confirmed' and v.vote = 'confirm') or (a.status in ('wrong', 'corrected') and v.vote in ('disagree', 'correct')))
       and not exists (select 1 from myc_wallet_tx t where t.kind = 'mint' and t.memo = 'reward:wa:' || v.answer_id || ':' || replace(v.voter_node::text, '-', ''))
    union all
    select w.pub, 'reward:wp:' || v.parse_id || ':' || replace(v.voter_node::text, '-', ''), 50
      from myc_parse_votes v join myc_parses a on a.id = v.parse_id
      join lateral (select coalesce((select account_id from myc_account_nodes where node_id = v.voter_node),
                                    (select id from myc_accounts where contributor_id = v.contributor_id)) acc) x on true
      join myc_wallets w on w.account_id = x.acc and w.active
     where v.voter = 'person' and ((a.status = 'confirmed' and v.vote = 'confirm') or (a.status in ('wrong', 'corrected') and v.vote in ('disagree', 'correct')))
       and not exists (select 1 from myc_wallet_tx t where t.kind = 'mint' and t.memo = 'reward:wp:' || v.parse_id || ':' || replace(v.voter_node::text, '-', ''))
    union all
    select w.pub, 'reward:spk:' || v.msg_id || ':' || v.voter, 10
      from myc_speaker_votes v join myc_wallets w on w.active and md5('myc-spk-v1' || w.account_id::text) = v.voter
     where v.sense is not null and not exists (select 1 from myc_wallet_tx t where t.kind = 'mint' and t.memo = 'reward:spk:' || v.msg_id || ':' || v.voter)
    limit 500
  loop
    begin
      if myc_wallet_mint(r.pub, r.amt, r.ref) is not null then n := n + 1; end if;
    exception when sqlstate '53400' then exit;
    end;
  end loop;
  return jsonb_build_object('minted', n, 'block', myc_wallet_make_block());
end $$;
revoke all on function public.myc_wallet_rewards() from public, anon, authenticated;

-- ------------------------------------------------------------------ statystyki i sprzątanie
create or replace function public.myc_wallet_stats() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'wallets', (select count(*) from myc_wallets where active),
    'tx', (select last_id from myc_wallet_head where id = 1),
    'height', (select height from myc_wallet_head where id = 1),
    'final_height', (select max(height) from myc_wallet_blocks where final_at is not null),
    'supply', (select coalesce(sum(amount), 0) from myc_wallet_tx where kind = 'mint'),
    'pending_tx', (select count(*) from myc_wallet_tx where block is null),
    'validators', (select count(distinct node_id) from myc_wallet_attest where created_at > now() - interval '1 day'),
    'verify_tx_per_s', (select round((sum(n_sig)::numeric * 1000 / nullif(sum(ms), 0)), 1) from myc_wallet_attest where created_at > now() - interval '1 day'),
    'finality_s_median', (select percentile_cont(0.5) within group (order by extract(epoch from final_at - created_at)) from myc_wallet_blocks
                           where final_at is not null and created_at > now() - interval '7 days'),
    'by_node', coalesce((select jsonb_agg(x order by x.blocks desc) from (
        select node_id, count(*) blocks, sum(n_sig) sigs, sum(ms) ms, bool_and(eligible) eligible, max(created_at) last,
               array_agg(distinct backend) backends
        from myc_wallet_attest where created_at > now() - interval '7 days' group by node_id) x), '[]'))
$$;

-- Sprzątanie: dni kranu starsze niż 3 dni (limit liczy tylko bieżącą dobę i ostatnie 20 h); poświadczenia
-- nieuprawnionych węzłów do bloków ostatecznych po 7 dniach. Księga i bloki zostają (tylko dopisywanie).
create or replace function public.myc_wallet_gc() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; m int;
begin
  delete from myc_wallet_faucet where day < (now() at time zone 'Europe/Amsterdam')::date - 3; get diagnostics n = row_count;
  delete from myc_wallet_attest a using myc_wallet_blocks b
   where a.height = b.height and b.final_at is not null and not a.eligible and a.created_at < now() - interval '7 days';
  get diagnostics m = row_count;
  return n + m;
end $$;
revoke all on function public.myc_wallet_gc() from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array['myc_wallet_register(text, text)', 'myc_wallet_me()', 'myc_wallet_faucet_claim()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['myc_wallet_dir(text, text[])', 'myc_wallet_send(text, text, bigint, bigint, bigint, text, text)',
    'myc_node_key_register(uuid, text, text)', 'myc_wallet_eligible(uuid)',
    'myc_wallet_attest(uuid, int, text, boolean, text, bigint, int, int, int, text, text)', 'myc_wallet_stats()'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

select cron.unschedule(jobid) from cron.job where jobname in ('myc_wallet_block', 'myc_wallet_rewards', 'myc_wallet_gc');
select cron.schedule('myc_wallet_block', '* * * * *', $$select public.myc_wallet_make_block(), public.myc_wallet_try_final()$$);
select cron.schedule('myc_wallet_rewards', '*/5 * * * *', $$select public.myc_wallet_rewards()$$);
select cron.schedule('myc_wallet_gc', '41 3 * * *', $$select public.myc_wallet_gc()$$);
revoke all on function public.myc_wallet_tx_guard(), public.myc_wallet_block_guard() from public, anon, authenticated;
