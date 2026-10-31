-- Samouk (31.10.2026): grzybnia sama wybiera, czego się uczyć (bandyta nad typami zadań) i sama układa zadania
-- ze sprawdzalną odpowiedzią. Zapis tylko właściciel (Management API / scripts/samouk_run.py); odczyt publiczny –
-- węzły pobierają odłamki stąd, a strona pokazuje „czego grzybnia chce się teraz nauczyć i dlaczego”.
create table if not exists public.myc_lm_self (
  name text primary key check (name ~ '^self-[a-z]+-[0-9]{8}-[0-9]{4}\.bin\.gz$'),
  type text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes int not null,
  n int not null,
  data text not null,               -- base64 pliku .bin.gz (MYCLM1), ~50 KB
  created_at timestamptz not null default now()
);
create table if not exists public.myc_lm_curriculum (
  id bigserial primary key,
  at timestamptz not null default now(),
  measured jsonb not null,          -- {base: {version, path}, cand: {id, path} | null}
  stats jsonb not null,             -- per typ: acc, p_right, n, progress
  alloc jsonb not null,             -- per typ: liczba zadań treningu w rundzie
  why jsonb not null,               -- per typ: składniki wartości i zdanie uzasadnienia
  shards jsonb not null,            -- [{type, name, sha256, n}]
  wiki_jobs int not null default 3,
  probe jsonb not null              -- {seed, n, sha} – zbiór próbny (poza treningiem)
);
alter table public.myc_lm_self enable row level security;
alter table public.myc_lm_curriculum enable row level security;
revoke all on public.myc_lm_self, public.myc_lm_curriculum from anon, authenticated;
grant select on public.myc_lm_self, public.myc_lm_curriculum to anon, authenticated;
drop policy if exists myc_lm_self_read on public.myc_lm_self;
create policy myc_lm_self_read on public.myc_lm_self for select using (true);
drop policy if exists myc_lm_curriculum_read on public.myc_lm_curriculum;
create policy myc_lm_curriculum_read on public.myc_lm_curriculum for select using (true);
-- sprzątanie: odłamki spoza 3 ostatnich planów i plany starsze niż 200 ostatnich
create or replace function public.myc_samouk_gc() returns void language sql security definer set search_path = public as $$
  delete from myc_lm_self s where not exists (
    select 1 from (select shards from myc_lm_curriculum order by id desc limit 3) c, jsonb_array_elements(c.shards) e
    where e->>'name' = s.name) and s.created_at < now() - interval '1 hour';
  delete from myc_lm_curriculum where id < (select coalesce(max(id), 0) - 200 from myc_lm_curriculum);
$$;
revoke execute on function public.myc_samouk_gc() from public, anon, authenticated;
