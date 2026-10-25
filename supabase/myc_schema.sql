-- Mycelium AI: wspólny stan węzłów (nauka z pytań). Darmowy plan Supabase.
-- Tabele z prefiksem myc_ w schemacie public. Bez danych osobowych:
-- node_id to losowy UUID generowany na urządzeniu, IP trafia tylko jako
-- solony skrót do limitera (tabela niewidoczna dla klientów, czyszczona po 1 h).

create table if not exists public.myc_answers (
  id bigint generated always as identity primary key,
  question_id text not null check (question_id ~ '^[iks][0-9]{2,3}$'),
  node_id uuid not null,
  kind text not null default 'browser' check (kind in ('browser', 'python', 'esp')),
  answer text not null check (char_length(answer) between 1 and 40 and answer ~ '^[a-z_]+$'),
  created_at timestamptz not null default now(),
  unique (question_id, node_id)
);
create index if not exists myc_answers_node_idx on public.myc_answers (node_id, created_at desc);

create table if not exists public.myc_node_stats (
  id bigint generated always as identity primary key,
  node_id uuid not null,
  kind text not null default 'browser' check (kind in ('browser', 'python', 'esp')),
  label text check (label is null or (char_length(label) <= 24 and label ~ '^[[:alnum:] ._-]*$')),
  acc jsonb not null default '{}' check (pg_column_size(acc) < 600 and jsonb_typeof(acc) = 'object'),
  n_answers int not null default 0 check (n_answers between 0 and 100000),
  created_at timestamptz not null default now()
);
create index if not exists myc_node_stats_node_idx on public.myc_node_stats (node_id, created_at desc);

create table if not exists public.myc_gold (
  question_id text primary key,
  answer text not null
);

create table if not exists public.myc_rate (
  bucket text not null,
  minute timestamptz not null,
  n int not null default 0,
  primary key (bucket, minute)
);

alter table public.myc_answers enable row level security;
alter table public.myc_node_stats enable row level security;
alter table public.myc_gold enable row level security;
alter table public.myc_rate enable row level security;

revoke all on public.myc_gold, public.myc_rate from anon, authenticated;
revoke all on public.myc_answers, public.myc_node_stats from anon, authenticated;
grant select, insert on public.myc_answers, public.myc_node_stats to anon, authenticated;

drop policy if exists myc_answers_read on public.myc_answers;
create policy myc_answers_read on public.myc_answers for select to anon, authenticated using (true);
drop policy if exists myc_answers_insert on public.myc_answers;
create policy myc_answers_insert on public.myc_answers for insert to anon, authenticated
  with check (created_at > now() - interval '1 minute' and created_at < now() + interval '1 minute');
drop policy if exists myc_stats_read on public.myc_node_stats;
create policy myc_stats_read on public.myc_node_stats for select to anon, authenticated using (true);
drop policy if exists myc_stats_insert on public.myc_node_stats;
create policy myc_stats_insert on public.myc_node_stats for insert to anon, authenticated
  with check (created_at > now() - interval '1 minute' and created_at < now() + interval '1 minute');

-- Limiter: na węzeł i na (solony skrót) IP, okno 1 minuty.
create or replace function public.myc_rate_limit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ip text := public.myc_client_ip();
  m timestamptz := date_trunc('minute', now());
  lim_node int := case tg_table_name when 'myc_answers' then 40 when 'myc_growth' then 12 when 'myc_user_questions' then 10 else 6 end;
  n_node int; n_ip int;
begin
  insert into myc_rate as r (bucket, minute, n) values (tg_table_name || ':n:' || new.node_id, m, 1)
    on conflict (bucket, minute) do update set n = r.n + 1 returning r.n into n_node;
  insert into myc_rate as r (bucket, minute, n) values (tg_table_name || ':ip:' || md5('myc-salt-v1' || ip), m, 1)
    on conflict (bucket, minute) do update set n = r.n + 1 returning r.n into n_ip;
  if n_node > lim_node or n_ip > lim_node * 4 then
    raise exception 'myc: rate limit' using errcode = 'PT429';
  end if;
  if random() < 0.02 then delete from myc_rate where minute < now() - interval '1 hour'; end if;
  new.created_at := now();
  return new;
end $$;

drop trigger if exists myc_answers_rl on public.myc_answers;
create trigger myc_answers_rl before insert on public.myc_answers for each row execute function public.myc_rate_limit();
drop trigger if exists myc_stats_rl on public.myc_node_stats;
create trigger myc_stats_rl before insert on public.myc_node_stats for each row execute function public.myc_rate_limit();

-- Wyniki na pytaniach kontrolnych bez ujawniania poprawnych odpowiedzi.
create or replace function public.myc_gold_stats()
returns table (node_id uuid, n int, correct int)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.node_id, count(*)::int, count(*) filter (where a.answer = g.answer)::int
  from myc_answers a join myc_gold g using (question_id)
  group by a.node_id
$$;

create or replace function public.myc_gold_daily()
returns table (day date, n int, correct int)
language sql stable security definer set search_path = public, pg_temp as $$
  select (a.created_at at time zone 'Europe/Amsterdam')::date, count(*)::int, count(*) filter (where a.answer = g.answer)::int
  from myc_answers a join myc_gold g using (question_id)
  group by 1 order by 1
$$;

revoke all on function public.myc_gold_stats(), public.myc_gold_daily(), public.myc_rate_limit() from public;
grant execute on function public.myc_gold_stats(), public.myc_gold_daily() to anon, authenticated;

-- Dziennik wzrostu (autonomiczna pętla: cele, akcje, przyjęte/odrzucone zmiany, IQ).
create table if not exists public.myc_growth (
  id bigint generated always as identity primary key,
  node_id uuid not null,
  kind text not null default 'browser' check (kind in ('browser', 'python', 'esp')),
  event text not null check (event in ('goal', 'action', 'accept', 'reject', 'spawn', 'prune', 'join', 'question', 'train', 'answer', 'verify')),
  detail jsonb not null default '{}' check (pg_column_size(detail) < 800 and jsonb_typeof(detail) = 'object'),
  iq real check (iq is null or iq between 0 and 300),
  created_at timestamptz not null default now()
);
create index if not exists myc_growth_time_idx on public.myc_growth (created_at desc);
alter table public.myc_growth enable row level security;
revoke all on public.myc_growth from anon, authenticated;
grant select, insert on public.myc_growth to anon, authenticated;
drop policy if exists myc_growth_read on public.myc_growth;
create policy myc_growth_read on public.myc_growth for select to anon, authenticated using (true);
drop policy if exists myc_growth_insert on public.myc_growth;
create policy myc_growth_insert on public.myc_growth for insert to anon, authenticated
  with check (created_at > now() - interval '1 minute' and created_at < now() + interval '1 minute');
drop trigger if exists myc_growth_rl on public.myc_growth;
create trigger myc_growth_rl before insert on public.myc_growth for each row execute function public.myc_rate_limit();

-- Przygotowanie pod przyszłe nagrody „learn-to-earn” (bez kryptowalut na razie).
-- Każda odpowiedź ma stabilny contributor_id (losowy UUID osoby, wspólny dla jej
-- urządzeń; w przyszłości może zostać powiązany z portfelem w myc_contributors) oraz
-- status zatwierdzenia ustalany WYŁĄCZNIE przez konsensus agentów (service_role/cron).
alter table public.myc_answers add column if not exists contributor_id uuid;
create index if not exists myc_answers_contrib_idx on public.myc_answers (contributor_id);

create or replace function public.myc_answers_defaults() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.contributor_id := coalesce(new.contributor_id, new.node_id);
  return new;
end $$;
drop trigger if exists myc_answers_defaults on public.myc_answers;
create trigger myc_answers_defaults before insert on public.myc_answers for each row execute function public.myc_answers_defaults();

create table if not exists public.myc_contributors (
  contributor_id uuid primary key,
  created_at timestamptz not null default now(),
  wallet_ref text  -- zarezerwowane: powiązanie z portfelem w przyszłości (nieużywane)
);

create table if not exists public.myc_approvals (
  answer_id bigint primary key references public.myc_answers (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  truth text,                -- odpowiedź uznana za prawdziwą przez konsensus
  posterior real,            -- pewność konsensusu dla tej prawdy
  contributor_trust real,    -- trafność węzła/osoby w chwili decyzji
  method text not null default 'dawid-skene-1coin+gold',
  round_id text,             -- identyfikator rundy rozliczenia (np. przebieg crona)
  decided_by text,           -- kto rozliczył (np. 'cron:github-actions')
  decided_at timestamptz not null default now()
);
alter table public.myc_contributors enable row level security;
alter table public.myc_approvals enable row level security;
revoke all on public.myc_contributors, public.myc_approvals from anon, authenticated;
grant select on public.myc_approvals to anon, authenticated;
drop policy if exists myc_approvals_read on public.myc_approvals;
create policy myc_approvals_read on public.myc_approvals for select to anon, authenticated using (true);
-- Zapisy do myc_approvals tylko service_role (omija RLS). Brak polityki insert dla anon.

create or replace view public.myc_contributions with (security_invoker = true) as
  select a.id as answer_id, a.question_id, a.contributor_id, a.node_id, a.answer, a.created_at,
         coalesce(p.status, 'pending') as status, p.truth, p.posterior, p.decided_at
  from public.myc_answers a left join public.myc_approvals p on p.answer_id = a.id;
grant select on public.myc_contributions to anon, authenticated;

-- Aktualizacja listy zdarzeń dla istniejących instalacji (kanał aktywności agentów).
alter table public.myc_growth drop constraint if exists myc_growth_event_check;
alter table public.myc_growth add constraint myc_growth_event_check
  check (event in ('goal', 'action', 'accept', 'reject', 'spawn', 'prune', 'join', 'question', 'train', 'answer', 'verify'));
alter table public.myc_growth add column if not exists agent text check (agent is null or (char_length(agent) <= 32 and agent ~ '^[[:alnum:] ._:-]*$'));

-- Tryb nauczyciela: własne fakty, pary pytanie–odpowiedź i przykłady od ludzi.
-- Każdy wpis staje się pytaniem dla całej grzybni (fakt/QA: tak/nie, przykład: etykieta intencji).
create table if not exists public.myc_user_questions (
  id text primary key check (id ~ '^u[0-9a-f]{8}$'),
  kind text not null check (kind in ('fact', 'qa', 'example')),
  text text not null check (char_length(text) between 3 and 300),
  answer text check (answer is null or char_length(answer) <= 200),
  node_id uuid not null,
  owner boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.myc_user_questions enable row level security;
revoke all on public.myc_user_questions from anon, authenticated;
grant select, insert on public.myc_user_questions to anon, authenticated;
drop policy if exists myc_uq_read on public.myc_user_questions;
create policy myc_uq_read on public.myc_user_questions for select to anon, authenticated using (true);
drop policy if exists myc_uq_insert on public.myc_user_questions;
create policy myc_uq_insert on public.myc_user_questions for insert to anon, authenticated
  with check (created_at > now() - interval '1 minute' and created_at < now() + interval '1 minute');

alter table public.myc_answers drop constraint if exists myc_answers_question_id_check;
alter table public.myc_answers add constraint myc_answers_question_id_check
  check (question_id ~ '^([iks][0-9]{2,3}|u[0-9a-f]{8})$');

-- Klucz właściciela: tylko skrót w bazie (tabela niewidoczna). Klient wysyła klucz
-- w polu owner_key, wyzwalacz sprawdza skrót, ustawia owner=true i USUWA klucz przed zapisem.
create table if not exists public.myc_owner (key_hash text primary key);
alter table public.myc_owner enable row level security;
revoke all on public.myc_owner from anon, authenticated;
alter table public.myc_answers add column if not exists owner boolean not null default false;
alter table public.myc_answers add column if not exists owner_key text;
alter table public.myc_user_questions add column if not exists owner_key text;

create or replace function public.myc_owner_check() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  new.owner := new.owner_key is not null
    and exists (select 1 from myc_owner where key_hash = encode(extensions.digest(new.owner_key, 'sha256'), 'hex'));
  new.owner_key := null;
  return new;
end $$;
drop trigger if exists myc_answers_owner on public.myc_answers;
create trigger myc_answers_owner before insert on public.myc_answers for each row execute function public.myc_owner_check();
drop trigger if exists myc_uq_owner on public.myc_user_questions;
create trigger myc_uq_owner before insert on public.myc_user_questions for each row execute function public.myc_owner_check();
drop trigger if exists myc_uq_rl on public.myc_user_questions;
create trigger myc_uq_rl before insert on public.myc_user_questions for each row execute function public.myc_rate_limit();
revoke all on function public.myc_owner_check() from public;

-- Nazwy agentów mogą mieć polskie litery i „/” (np. „Pi/cron”); blokujemy tylko znaki ryzykowne.
alter table public.myc_growth drop constraint if exists myc_growth_agent_check;
alter table public.myc_growth add constraint myc_growth_agent_check
  check (agent is null or (char_length(agent) <= 32 and agent !~ '[<>"`\\[:cntrl:]]'));

-- Słowniki: pytania o słowa (w#####c### = słowo × kategoria, tak/nie) i słowa od nauczycieli (kind 'word').
alter table public.myc_answers drop constraint if exists myc_answers_question_id_check;
alter table public.myc_answers add constraint myc_answers_question_id_check
  check (question_id ~ '^([iks][0-9]{2,3}|u[0-9a-f]{8}|w[0-9]{5}c[0-9]{3})$');
alter table public.myc_user_questions drop constraint if exists myc_user_questions_kind_check;
alter table public.myc_user_questions add constraint myc_user_questions_kind_check
  check (kind in ('fact', 'qa', 'example', 'word'));

-- Zadania captcha: cg#####k# (obraz × klasa), ct##### (litera), cr##### (obrót), co##### (kolejność), cm##### (para PL↔EN).
alter table public.myc_answers drop constraint if exists myc_answers_question_id_check;
alter table public.myc_answers add constraint myc_answers_question_id_check
  check (question_id ~ '^([iks][0-9]{2,3}|u[0-9a-f]{8}|w[0-9]{5}c[0-9]{3}|cg[0-9]{5}k[0-9]|c[tromn][0-9]{5})$');

-- Zadania wielokrotne (siatka, kosze, zawężanie) wysyłają kilkanaście odpowiedzi naraz.
create or replace function public.myc_rate_limit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ip text := public.myc_client_ip();
  m timestamptz := date_trunc('minute', now());
  lim_node int := case tg_table_name when 'myc_answers' then 120 when 'myc_growth' then 12 when 'myc_user_questions' then 10 else 6 end;
  n_node int; n_ip int;
begin
  insert into myc_rate as r (bucket, minute, n) values (tg_table_name || ':n:' || new.node_id, m, 1)
    on conflict (bucket, minute) do update set n = r.n + 1 returning r.n into n_node;
  insert into myc_rate as r (bucket, minute, n) values (tg_table_name || ':ip:' || md5('myc-salt-v1' || ip), m, 1)
    on conflict (bucket, minute) do update set n = r.n + 1 returning r.n into n_ip;
  if n_node > lim_node or n_ip > lim_node * 4 then
    raise exception 'myc: rate limit' using errcode = 'PT429';
  end if;
  if random() < 0.02 then delete from myc_rate where minute < now() - interval '1 hour'; end if;
  new.created_at := now();
  return new;
end $$;
revoke all on function public.myc_rate_limit() from public;

-- Trafność na pytaniach kontrolnych wg rodzaju zadania i dnia (bez ujawniania odpowiedzi).
create or replace function public.myc_gold_by_type()
returns table (kind text, day date, n int, correct int)
language sql stable security definer set search_path = public, pg_temp as $$
  select case when a.question_id like 'c%' then left(a.question_id, 2) else left(a.question_id, 1) end,
    (a.created_at at time zone 'Europe/Amsterdam')::date, count(*)::int, count(*) filter (where a.answer = g.answer)::int
  from myc_answers a join myc_gold g using (question_id)
  group by 1, 2 order by 2, 1
$$;
revoke all on function public.myc_gold_by_type() from public;
grant execute on function public.myc_gold_by_type() to anon, authenticated;

-- Tryb „Start sesji”: dobrowolny wkład mocy obliczeniowej (FedAvg w przeglądarkach).
-- Wiersz = wagi modelu wytrenowanego lokalnie na odłamku otwartych danych (int8 + skala, base64).
-- Bez danych osobowych; contributor_id/n/ms służą do liczenia wkładu (przyszłe nagrody).
create table if not exists public.myc_fed (
  id bigint generated always as identity primary key,
  node_id uuid not null,
  contributor_id uuid,
  model text not null check (model in ('fashion', 'letters')),
  round int not null check (round between 0 and 10000000),
  n int not null check (n between 1 and 5000),
  scale real not null check (scale > 0 and scale < 100),
  w text not null check (char_length(w) <= 8000 and w ~ '^[A-Za-z0-9+/=]+$'),
  metrics jsonb not null default '{}' check (pg_column_size(metrics) < 400 and jsonb_typeof(metrics) = 'object'),
  ms int check (ms is null or ms between 0 and 3600000),
  created_at timestamptz not null default now()
);
create index if not exists myc_fed_model_idx on public.myc_fed (model, id desc);
create index if not exists myc_fed_contrib_idx on public.myc_fed (contributor_id);
alter table public.myc_fed enable row level security;
revoke all on public.myc_fed from anon, authenticated;
grant select, insert on public.myc_fed to anon, authenticated;
drop policy if exists myc_fed_read on public.myc_fed;
create policy myc_fed_read on public.myc_fed for select to anon, authenticated using (true);
drop policy if exists myc_fed_insert on public.myc_fed;
create policy myc_fed_insert on public.myc_fed for insert to anon, authenticated
  with check (created_at > now() - interval '1 minute' and created_at < now() + interval '1 minute');
drop trigger if exists myc_fed_rl on public.myc_fed;
create trigger myc_fed_rl before insert on public.myc_fed for each row execute function public.myc_rate_limit();
create or replace function public.myc_fed_defaults() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.contributor_id := coalesce(new.contributor_id, new.node_id);
  return new;
end $$;
drop trigger if exists myc_fed_defaults on public.myc_fed;
create trigger myc_fed_defaults before insert on public.myc_fed for each row execute function public.myc_fed_defaults();

-- Wkład na osobę (pod przyszłe nagrody): rundy, próbki, czas obliczeń, dni aktywności.
create or replace function public.myc_contrib_stats()
returns table (contributor_id uuid, rounds int, samples bigint, ms bigint, days int, last timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  -- próbki: faktycznie przetworzone (metrics.samples); stare wiersze bez pola miały stałe 8 epok
  select contributor_id, count(*)::int, sum(coalesce((metrics ->> 'samples')::bigint, n::bigint * 8))::bigint, coalesce(sum(ms), 0)::bigint,
    count(distinct (created_at at time zone 'Europe/Amsterdam')::date)::int, max(created_at)
  from myc_fed group by contributor_id order by 3 desc limit 200
$$;
revoke all on function public.myc_contrib_stats() from public;
grant execute on function public.myc_contrib_stats() to anon, authenticated;
