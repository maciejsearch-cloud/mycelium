-- Rozmowy jako dane do nauki (anonimowe, tylko za zgodą użytkownika – przełącznik w zakładce Rozmowa).
-- Jeden wiersz = wymiana (wiadomość + odpowiedź). Brak publicznego odczytu treści; publicznie tylko liczniki.
create table if not exists public.myc_chats (
  id bigint generated always as identity primary key,
  node_id uuid not null,
  conv uuid not null,
  turn int not null check (turn between 0 and 1000),
  user_text text not null check (char_length(user_text) between 1 and 4000),
  reply text not null check (char_length(reply) between 1 and 6000),
  act text not null check (act ~ '^[a-z_]{2,20}$'),
  mode text not null default 'lite' check (mode in ('lite', 'mesh')),
  lang text not null default 'pl' check (lang in ('pl', 'en')),
  feedback smallint check (feedback in (-1, 1)),
  created_at timestamptz not null default now()
);
create index if not exists myc_chats_created on public.myc_chats (created_at);
alter table public.myc_chats enable row level security;
revoke all on public.myc_chats from anon, authenticated;
grant insert on public.myc_chats to anon, authenticated;
drop policy if exists myc_chats_ins on public.myc_chats;
create policy myc_chats_ins on public.myc_chats for insert with check (true);
drop trigger if exists myc_chats_rl on public.myc_chats;
create trigger myc_chats_rl before insert on public.myc_chats for each row execute function public.myc_rate_limit();

create or replace function public.myc_chat_stats()
returns table (day date, exchanges int, convs int, unknown int, lite int, mesh int)
language sql stable security definer set search_path = public, pg_temp as $$
  select (created_at at time zone 'Europe/Amsterdam')::date, count(*)::int, count(distinct conv)::int,
         count(*) filter (where act = 'unknown')::int, count(*) filter (where mode = 'lite')::int, count(*) filter (where mode = 'mesh')::int
  from myc_chats group by 1 order by 1
$$;
revoke all on function public.myc_chat_stats() from public;
grant execute on function public.myc_chat_stats() to anon, authenticated;
