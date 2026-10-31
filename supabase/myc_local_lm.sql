-- Model grzybni w przeglądarce (web/src/mesh/local.ts): odpowiedzi wygenerowane lokalnie mają tryb 'local'
-- (dotąd tylko 'lite' = tryb lekki w przeglądarce i 'mesh' = węzły). Uczciwe rozróżnienie ścieżki w danych.
alter table public.myc_chats drop constraint if exists myc_chats_mode_check;
alter table public.myc_chats add constraint myc_chats_mode_check check (mode in ('lite', 'mesh', 'local'));
alter table public.myc_chat_answers drop constraint if exists myc_chat_answers_mode_check;
alter table public.myc_chat_answers add constraint myc_chat_answers_mode_check check (mode in ('lite', 'mesh', 'local'));
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'myc_answer_log' limit 1;
  if d is not null and position('when p_mode = ''mesh'' then ''mesh'' else ''lite'' end' in d) > 0 then
    execute replace(d, 'case when p_mode = ''mesh'' then ''mesh'' else ''lite'' end',
      'case when p_mode in (''mesh'', ''local'') then p_mode else ''lite'' end');
  end if;
end $$;
