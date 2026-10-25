-- Świadkowie (tryb pasywny węzła PC, src/iot_mycelium/mesh/passive.py): tanie sprawdzenia spójności wyników treningu
-- innych węzłów i wydań węzła (sumy SHA-256 strona ↔ wydanie GitHub). Jeden głos na węzeł i przedmiot.
-- Świadectwa są POMOCNICZE: nie zmieniają bramki, wyników ani punktów; widok pokazuje, które wyniki/wydania
-- zebrały flagi od kilku niezależnych węzłów (sygnał do ręcznej kontroli fałszywych węzłów).

create table if not exists public.myc_witness (
  id bigint generated always as identity primary key,
  node_id uuid not null,
  kind text not null check (kind in ('result', 'release')),
  subject text not null check (subject ~ '^[A-Za-z0-9._-]{1,64}$'),
  ok boolean not null,
  checks jsonb not null default '{}' check (jsonb_typeof(checks) = 'object' and pg_column_size(checks) < 1500),
  created_at timestamptz not null default now(),
  unique (node_id, kind, subject)
);
create index if not exists myc_witness_subject_idx on public.myc_witness (kind, subject);

alter table public.myc_witness enable row level security;
revoke all on public.myc_witness from public, anon, authenticated;
grant select on public.myc_witness to anon, authenticated;
drop policy if exists myc_witness_read on public.myc_witness;
create policy myc_witness_read on public.myc_witness for select using (true);

create or replace function public.myc_witness_report(p_node uuid, p_kind text, p_subject text, p_ok boolean, p_checks jsonb)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare chk jsonb := '{}';
begin
  perform myc_rl('witness:' || p_node, 20);
  if p_kind not in ('result', 'release') then raise exception 'myc: zły rodzaj' using errcode = '22023'; end if;
  if p_kind = 'result' then
    if p_subject !~ '^[0-9]{1,18}$' then raise exception 'myc: zły przedmiot' using errcode = '22023'; end if;
    -- własnych wyników nie da się poświadczać; wynik musi istnieć
    if not exists (select 1 from myc_results where id = p_subject::bigint and node_id <> p_node) then
      raise exception 'myc: brak wyniku' using errcode = '22023';
    end if;
  end if;
  -- tylko flagi logiczne (bez dowolnego tekstu)
  select coalesce(jsonb_object_agg(key, value), '{}') into chk
    from jsonb_each(coalesce(p_checks, '{}')) where key ~ '^[a-z_]{1,32}$' and jsonb_typeof(value) = 'boolean';
  insert into myc_witness (node_id, kind, subject, ok, checks) values (p_node, p_kind, p_subject, coalesce(p_ok, false), chk)
    on conflict (node_id, kind, subject) do nothing;
  return found;
end $$;
revoke all on function public.myc_witness_report(uuid, text, text, boolean, jsonb) from public;
grant execute on function public.myc_witness_report(uuid, text, text, boolean, jsonb) to anon, authenticated;

-- security_invoker: widok działa z uprawnieniami wywołującego (RLS myc_witness), klienci tylko czytają (audyt 25.10.2026)
create or replace view public.myc_witness_summary with (security_invoker = true) as
select kind, subject, count(*) as witnesses, count(*) filter (where ok) as ok, count(*) filter (where not ok) as flagged,
       max(created_at) as last_at
  from public.myc_witness group by kind, subject;
revoke all on public.myc_witness_summary from anon, authenticated;
grant select on public.myc_witness_summary to anon, authenticated;
