-- SelfModel (1.11.2026): migawki „co grzybnia wie o sobie” – pomiary, twierdzenia z przedziałami 95%, kontrola
-- spójności z kolejnym pomiarem, historia decyzji samouka (src/iot_mycelium/selfmodel, scripts/selfmodel_run.py).
-- Zapis tylko właściciel (Management API); odczyt publiczny – węzły i strona. Nowa migawka tylko przy zmianie wejść.
create table if not exists public.myc_self_model (
  id bigserial primary key,
  at timestamptz not null default now(),
  fingerprint text not null unique check (fingerprint ~ '^[0-9a-f]{32}$'),
  snapshot jsonb not null check (pg_column_size(snapshot) < 200000)
);
alter table public.myc_self_model enable row level security;
revoke all on public.myc_self_model from anon, authenticated;
grant select on public.myc_self_model to anon, authenticated;
drop policy if exists myc_self_model_read on public.myc_self_model;
create policy myc_self_model_read on public.myc_self_model for select using (true);
revoke all on sequence public.myc_self_model_id_seq from anon, authenticated;
-- sprzątanie: 200 ostatnich migawek
create or replace function public.myc_self_model_gc() returns void language sql security definer set search_path = public as $$
  delete from myc_self_model where id < (select coalesce(max(id), 0) - 200 from myc_self_model);
$$;
revoke execute on function public.myc_self_model_gc() from public, anon, authenticated;
