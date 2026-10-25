-- „Strzępki” – wielowarstwowa wiedza „po nitce do kłębka”.
-- Warstwa 0: atomowe fakty (podmiot – relacja – obiekt) ze źródłem i zaufaniem.
-- Warstwa 1: pojęcia (ta sama encja / synonimy) łączące strzępki; warstwa 2: tematy (korzenie is-a).
-- Zapis wyłącznie przez RPC (walidacja, limiter, zaufanie liczone w bazie ze źródła, nie od klienta).
-- room: 'main' = prawdziwa grzybnia, 'e2e' = izolowany pokój testów (sprzątany po teście).

create table if not exists public.myc_frags (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  layer smallint not null check (layer between 0 and 3),
  key text not null check (char_length(key) <= 400),
  subj text not null check (char_length(subj) between 1 and 160),
  rel text not null check (rel ~ '^[a-z_]{2,24}$'),
  obj text not null default '' check (char_length(obj) <= 300),
  lang text not null default 'pl' check (lang in ('pl', 'en', 'xx')),
  source text not null check (source in ('wikidata', 'plwordnet', 'wordnet', 'wiktionary', 'consensus', 'teach', 'captcha', 'owner', 'chat', 'link')),
  source_ref text check (source_ref is null or char_length(source_ref) <= 200),
  trust real not null check (trust between 0 and 1),
  status text not null default 'active' check (status in ('active', 'conflict', 'verified', 'rejected')),
  n_support int not null default 1 check (n_support >= 0),
  node_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room, key)
);
create index if not exists myc_frags_subj on public.myc_frags (room, lower(subj));
create index if not exists myc_frags_layer on public.myc_frags (room, layer, created_at);
create index if not exists myc_frags_status on public.myc_frags (room, status) where status <> 'active';

create table if not exists public.myc_frag_links (
  id bigint generated always as identity primary key,
  room text not null default 'main' check (room in ('main', 'e2e')),
  src bigint not null references public.myc_frags (id) on delete cascade,
  dst bigint not null references public.myc_frags (id) on delete cascade,
  kind text not null check (kind in ('part_of', 'same_as', 'synonym', 'is_a', 'supports', 'contradicts', 'similar', 'translation')),
  weight real not null default 1 check (weight between 0 and 1),
  node_id uuid,
  created_at timestamptz not null default now(),
  unique (src, dst, kind),
  check (src <> dst)
);
create index if not exists myc_frag_links_dst on public.myc_frag_links (dst);

alter table public.myc_frags enable row level security;
alter table public.myc_frag_links enable row level security;
revoke all on public.myc_frags, public.myc_frag_links from anon, authenticated;
grant select on public.myc_frags, public.myc_frag_links to anon, authenticated;
drop policy if exists myc_frags_read on public.myc_frags;
create policy myc_frags_read on public.myc_frags for select to anon, authenticated using (true);
drop policy if exists myc_frag_links_read on public.myc_frag_links;
create policy myc_frag_links_read on public.myc_frag_links for select to anon, authenticated using (true);

create or replace function public.myc_frag_key(p_layer int, p_subj text, p_rel text, p_obj text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select p_layer || ':' || lower(btrim(regexp_replace(p_subj, '\s+', ' ', 'g'))) || '|' || p_rel || '|' || lower(btrim(regexp_replace(coalesce(p_obj, ''), '\s+', ' ', 'g')))
$$;

-- Relacje funkcyjne: jedna prawdziwa wartość na podmiot → różne obiekty = sprzeczność do Weryfikuj.
create or replace function public.myc_frag_functional(p_rel text) returns boolean
language sql immutable as $$ select p_rel in ('populacja', 'stolica', 'powierzchnia', 'rok', 'data_urodzenia', 'data_smierci', 'wysokosc', 'intencja', 'etykieta', 'tlumaczenie_odp') $$;

-- Zaufanie wynika ze źródła (klient nie może go podbić). Owner tylko przez myc_review_submit.
create or replace function public.myc_frag_trust(p_source text, p_hint real) returns real
language sql immutable as $$
  select case p_source
    when 'wikidata' then 0.9 when 'plwordnet' then 0.85 when 'wordnet' then 0.85 when 'wiktionary' then 0.8
    when 'consensus' then least(greatest(coalesce(p_hint, 0.5), 0), 0.8)
    when 'teach' then 0.5 when 'captcha' then least(greatest(coalesce(p_hint, 0.5), 0), 0.7)
    when 'chat' then 0.4 when 'link' then least(greatest(coalesce(p_hint, 0.5), 0), 0.85)
    else 0.3 end::real
$$;

-- Dodaj strzępki/pojęcia/tematy i powiązania (po kluczach). Zwraca liczby dodanych i sprzeczności.
-- p_frags: [{layer, subj, rel, obj, lang, source, ref, hint}], p_links: [{src:{layer,subj,rel,obj}, dst:{...}, kind, w}]
create or replace function public.myc_frag_add(p_node uuid, p_frags jsonb, p_links jsonb default '[]', p_room text default 'main')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f jsonb; l jsonb; k text; s bigint; d bigint; n_f int := 0; n_l int := 0; n_c int := 0; r record;
begin
  if p_room not in ('main', 'e2e') then raise exception 'myc: room'; end if;
  if jsonb_typeof(p_frags) <> 'array' or jsonb_array_length(p_frags) > 250 or jsonb_typeof(coalesce(p_links, '[]')) <> 'array' or jsonb_array_length(coalesce(p_links, '[]')) > 400 then
    raise exception 'myc: batch too large' using errcode = '22023';
  end if;
  perform myc_rl('frag:n:' || p_node, 40);
  for f in select * from jsonb_array_elements(p_frags) loop
    if coalesce(f ->> 'source', '') in ('owner') then continue; end if;
    k := myc_frag_key((f ->> 'layer')::int, f ->> 'subj', f ->> 'rel', f ->> 'obj');
    insert into myc_frags (room, layer, key, subj, rel, obj, lang, source, source_ref, trust, node_id)
    values (p_room, (f ->> 'layer')::int, k, btrim(f ->> 'subj'), f ->> 'rel', btrim(coalesce(f ->> 'obj', '')), coalesce(f ->> 'lang', 'pl'),
            f ->> 'source', left(f ->> 'ref', 200), myc_frag_trust(f ->> 'source', (f ->> 'hint')::real), p_node)
    on conflict (room, key) do update set n_support = myc_frags.n_support + case when myc_frags.node_id is distinct from excluded.node_id then 1 else 0 end,
      updated_at = now()
    returning id, layer, subj, rel, obj, status, (xmax = 0) as ins into r;
    if r.ins then n_f := n_f + 1; end if;
    -- sprzeczność: ta sama encja i relacja funkcyjna, inna wartość
    if r.layer = 0 and myc_frag_functional(r.rel) and r.status = 'active' then
      update myc_frags set status = 'conflict', updated_at = now()
       where room = p_room and layer = 0 and lower(subj) = lower(r.subj) and rel = r.rel and status in ('active', 'conflict')
         and exists (select 1 from myc_frags o where o.room = p_room and o.layer = 0 and lower(o.subj) = lower(r.subj) and o.rel = r.rel
                     and o.status in ('active', 'conflict', 'verified') and lower(o.obj) <> lower(r.obj))
         and status <> 'verified';
      get diagnostics s = row_count; n_c := n_c + s;
    end if;
  end loop;
  for l in select * from jsonb_array_elements(coalesce(p_links, '[]')) loop
    select id into s from myc_frags where room = p_room and key = myc_frag_key((l -> 'src' ->> 'layer')::int, l -> 'src' ->> 'subj', l -> 'src' ->> 'rel', l -> 'src' ->> 'obj');
    select id into d from myc_frags where room = p_room and key = myc_frag_key((l -> 'dst' ->> 'layer')::int, l -> 'dst' ->> 'subj', l -> 'dst' ->> 'rel', l -> 'dst' ->> 'obj');
    if s is null or d is null or s = d then continue; end if;
    insert into myc_frag_links (room, src, dst, kind, weight, node_id)
    values (p_room, s, d, l ->> 'kind', least(greatest(coalesce((l ->> 'w')::real, 1), 0), 1), p_node)
    on conflict (src, dst, kind) do nothing;
    if found then n_l := n_l + 1; end if;
  end loop;
  return jsonb_build_object('frags', n_f, 'links', n_l, 'conflicts', n_c);
end $$;
revoke all on function public.myc_frag_add(uuid, jsonb, jsonb, text) from public;
grant execute on function public.myc_frag_add(uuid, jsonb, jsonb, text) to anon, authenticated;

-- Liczby na warstwę i dzień (wykres wzrostu z prawdziwych wierszy).
create or replace function public.myc_frag_daily(p_room text default 'main')
returns table (day date, layer int, n int, links int)
language sql stable security definer set search_path = public, pg_temp as $$
  with f as (select (created_at at time zone 'Europe/Amsterdam')::date d, layer, count(*)::int n from myc_frags where room = p_room group by 1, 2),
       l as (select (created_at at time zone 'Europe/Amsterdam')::date d, count(*)::int n from myc_frag_links where room = p_room group by 1)
  select f.d, f.layer::int, f.n, coalesce(l.n, 0) from f left join l on l.d = f.d order by 1, 2
$$;
create or replace function public.myc_frag_stats(p_room text default 'main')
returns table (layer int, n int, conflict int, verified int, rejected int, links int)
language sql stable security definer set search_path = public, pg_temp as $$
  select layer::int, count(*)::int, count(*) filter (where status = 'conflict')::int, count(*) filter (where status = 'verified')::int,
         count(*) filter (where status = 'rejected')::int,
         (select count(*)::int from myc_frag_links where room = p_room)
  from myc_frags where room = p_room group by layer order by layer
$$;
revoke all on function public.myc_frag_daily(text), public.myc_frag_stats(text) from public;
grant execute on function public.myc_frag_daily(text), public.myc_frag_stats(text) to anon, authenticated;
