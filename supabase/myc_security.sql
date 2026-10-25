-- Utwardzenie (audyt bezpieczeństwa 24.10.2026, docs/security-audit.md).
-- 1) Widoki tylko do odczytu: bez praw zapisu dla anon/authenticated (myc_meanings_approved był
--    prostym, aktualizowalnym widokiem właściciela – anon mógł przez niego zmieniać/usuwać zatwierdzone znaczenia z pominięciem RLS).
-- 2) Widoki liczone z uprawnieniami wywołującego (security_invoker) – RLS tabel źródłowych obowiązuje.
-- 3) Stały search_path w funkcjach pomocniczych; funkcje wyzwalaczy niewywoływalne przez REST.
do $$
declare v text;
begin
  foreach v in array array['myc_meanings_approved','myc_node_contrib','myc_backend_contrib','myc_daily_contrib','myc_contributions'] loop
    execute format('revoke all on public.%I from anon, authenticated', v);
    execute format('grant select on public.%I to anon, authenticated', v);
    execute format('alter view public.%I set (security_invoker = true)', v);
  end loop;
end $$;

revoke insert, update, delete, truncate, references, trigger on public.myc_eval_set_history from anon, authenticated;

alter function public.myc_frag_functional(text) set search_path = public, pg_temp;
alter function public.myc_frag_trust(text, real) set search_path = public, pg_temp;

revoke execute on function public.myc_owner_check() from public, anon, authenticated;
revoke execute on function public.myc_rate_limit() from public, anon, authenticated;
revoke execute on function public.myc_answers_defaults() from public, anon, authenticated;
revoke execute on function public.myc_fed_defaults() from public, anon, authenticated;

-- Adres klienta do limitów: cf-connecting-ip (ustawia Cloudflare, klient nie może go podmienić),
-- awaryjnie ostatni element X-Forwarded-For. Pierwszy element X-Forwarded-For podaje klient – wcześniej
-- można było nim obejść limity „na IP”.
create or replace function public.myc_client_ip() returns text
language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    nullif(current_setting('request.headers', true)::json ->> 'cf-connecting-ip', ''),
    nullif(btrim(reverse(split_part(reverse(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', '')), ',', 1))), ''),
    'local')
$$;
revoke execute on function public.myc_client_ip() from public, anon, authenticated;

-- Limity liczone od prawdziwego adresu klienta (myc_client_ip).
CREATE OR REPLACE FUNCTION public.myc_rate_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.myc_rl(p_bucket text, p_lim integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  ip text := public.myc_client_ip();
  m timestamptz := date_trunc('minute', now());
  n1 int; n2 int;
begin
  insert into myc_rate as r (bucket, minute, n) values (p_bucket, m, 1)
    on conflict (bucket, minute) do update set n = r.n + 1 returning r.n into n1;
  insert into myc_rate as r (bucket, minute, n) values (split_part(p_bucket, ':', 1) || ':ip:' || md5('myc-salt-v1' || ip), m, 1)
    on conflict (bucket, minute) do update set n = r.n + 1 returning r.n into n2;
  if n1 > p_lim or n2 > p_lim * 6 then raise exception 'myc: rate limit' using errcode = 'PT429'; end if;
end $function$;

CREATE OR REPLACE FUNCTION public.myc_ip()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select md5('myc-salt-v1' || public.myc_client_ip())
$function$;
