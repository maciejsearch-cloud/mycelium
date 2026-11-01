-- Rotacja odpowiedzi kontrolnych (gold) – audyt przed publikacją kodu (25.10.2026).
-- Runda 1 (11 456 wierszy) była zapisana w plikach supabase/gold*.sql starego repozytorium, więc jest jawna.
-- Od rundy 2 odpowiedzi powstają z tajnego ziarna (scripts/goldkit.py, MYC_GOLD_SEED) i trafiają do bazy wyłącznie
-- skryptem scripts/gold_rotate.py – nigdy do repozytorium.
--
-- Wycofanie (retired_at) zamiast usuwania: odwracalne, a historia zostaje uczciwa – odpowiedzi udzielone PRZED
-- wycofaniem nadal liczą się do trafności i zaufania (wtedy klucz nie był jeszcze publiczny), późniejsze już nie.

alter table public.myc_gold add column if not exists round smallint not null default 1;
alter table public.myc_gold add column if not exists retired_at timestamptz;

-- Identyfikatory rundy ≥ 2 mają literę rundy po prefiksie (ib000, sb000, wb0000c012, cgb0000k3, crb0000);
-- [lmav]… to skróty sha (sól rundy). Ograniczenie jest nadzbiorem poprzedniego – stare odpowiedzi zostają ważne.
alter table public.myc_answers drop constraint if exists myc_answers_question_id_check;
alter table public.myc_answers add constraint myc_answers_question_id_check
  check (question_id ~ '^([iks][0-9]{2,3}|[is][a-z][0-9]{3}|u[0-9a-f]{8}|w([0-9]{5}|[a-z][0-9]{4})c[0-9]{3}|cg([0-9]{5}|[a-z][0-9]{4})k[0-9]|c[tromn]([0-9]{5}|[a-z][0-9]{4})|[lmav][0-9a-f]{8})$');

create or replace function public.myc_gold_daily()
returns table (day date, n int, correct int)
language sql stable security definer set search_path = public, pg_temp as $$
  select (a.created_at at time zone 'Europe/Amsterdam')::date, count(*)::int, count(*) filter (where a.answer = g.answer)::int
  from myc_answers a join myc_gold g using (question_id)
  where g.retired_at is null or a.created_at < g.retired_at
  group by 1 order by 1
$$;

create or replace function public.myc_gold_by_type()
returns table (kind text, day date, n int, correct int)
language sql stable security definer set search_path = public, pg_temp as $$
  select case when a.question_id like 'c%' then left(a.question_id, 2) else left(a.question_id, 1) end,
    (a.created_at at time zone 'Europe/Amsterdam')::date, count(*)::int, count(*) filter (where a.answer = g.answer)::int
  from myc_answers a join myc_gold g using (question_id)
  where g.retired_at is null or a.created_at < g.retired_at
  group by 1, 2 order by 2, 1
$$;

-- Wagi zaufania: złote etykiety = kontrolne pytania + decyzje właściciela (tylko odpowiedzi sprzed decyzji albo sprzed
-- wycofania pytania kontrolnego – żeby nie dało się „podejrzeć” etykiety i podbić sobie trafności).
create or replace function public.myc_gold_stats()
returns table (node_id uuid, n int, correct int)
language sql stable security definer set search_path = public, pg_temp as $$
  with g as (
    select question_id, answer, retired_at at from myc_gold
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

revoke all on function public.myc_gold_stats(), public.myc_gold_daily(), public.myc_gold_by_type() from public;
grant execute on function public.myc_gold_stats(), public.myc_gold_daily(), public.myc_gold_by_type() to anon, authenticated;
