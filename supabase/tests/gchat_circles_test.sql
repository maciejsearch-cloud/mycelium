-- Test czatu globalnego, ról, wzorców i kręgów w pokoju e2e. Całość w jednej transakcji zakończonej wyjątkiem
-- 'RESULT …' – Postgres wycofuje wszystko, w bazie nic nie zostaje. Podstaw :E2E_KEY (klucz pokoju e2e).
create or replace function pg_temp.t(q text) returns text language plpgsql as $f$
declare r text;
begin
  execute q into r;
  return coalesce(r, 'ok');
exception when others then return 'ERR: ' || sqlerrm;
end $f$;

do $$
declare u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  res jsonb := '{}'; j jsonb; m1 bigint; m2 bigint; cid bigint; inv text; k text := ':E2E_KEY'; h1 text; h2 text; pid bigint;
begin
  insert into auth.users (id, aud, role, is_anonymous, instance_id) values
    (u1, 'authenticated', 'authenticated', true, '00000000-0000-0000-0000-000000000000'),
    (u2, 'authenticated', 'authenticated', true, '00000000-0000-0000-0000-000000000000'),
    (u3, 'authenticated', 'authenticated', true, '00000000-0000-0000-0000-000000000000');
  h1 := 'e2edev' || substr(md5(random()::text), 1, 6); h2 := 'e2eusr' || substr(md5(random()::text), 1, 6);
  perform set_config('role', 'authenticated', true);

  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform myc_acct_create(h1, null, null, null, 'e2e');
  res := res || jsonb_build_object('claim_bad_key', pg_temp.t($q$select myc_gchat_claim_owner('zly-klucz-123')::text$q$));
  res := res || jsonb_build_object('claim', myc_gchat_claim_owner(k) ->> 'role');
  m1 := (myc_gchat_post('czy ktoś wie, nwm co z tym? pisz na test@example.com', null, 'pytanie', '{}') ->> 'id')::bigint;

  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('post_no_account', pg_temp.t($q$select myc_gchat_post('hej')::text$q$));
  perform myc_acct_create(h2, null, null, null, 'e2e');
  m2 := (myc_gchat_post('nwm xD suuuper, kurwa ' || h1, m1, 'emocja', array['wulgarne']) ->> 'id')::bigint;
  res := res || jsonb_build_object('dup', pg_temp.t($q$select myc_gchat_post('NWM xD suuuper, kurwa $q$ || h1 || $q$')::text$q$));
  res := res || jsonb_build_object('stored_body_uncensored', (select body from myc_gchat where id = m2), 'tags', (select tags from myc_gchat where id = m2));
  res := res || jsonb_build_object('user_mod_other', pg_temp.t(format('select myc_gchat_mod(%L, %s)::text', 'delete', m1)));
  res := res || jsonb_build_object('direct_insert', pg_temp.t($q$insert into myc_gchat (kind, handle, body) values ('user','x','y') returning 'inserted'$q$));
  res := res || jsonb_build_object('priv_read', pg_temp.t($q$select count(*)::text from myc_gchat_priv$q$));
  res := res || jsonb_build_object('modlog_user', pg_temp.t($q$select count(*)::text from myc_gchat_modlog()$q$));

  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('pin', myc_gchat_mod('pin', m1) ->> 'ok', 'mute', myc_gchat_mod('mute', m2, 5) ->> 'ok');
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('muted_post', pg_temp.t($q$select myc_gchat_post('jeszcze raz')::text$q$));
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform myc_gchat_mod('unmute', m2);
  res := res || jsonb_build_object('grant_mod', myc_gchat_mod('grant_role', null, null, 'moderator', null, h2) ->> 'ok');
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('mod_mutes_dev', pg_temp.t(format('select myc_gchat_mod(%L, %s, 5)::text', 'mute', m1)));
  res := res || jsonb_build_object('mod_ban', pg_temp.t(format('select myc_gchat_mod(%L, %s)::text', 'ban', m1)));
  m2 := (myc_gchat_post('jako moderator') ->> 'id')::bigint;
  res := res || jsonb_build_object('mod_role_badge', (select role from myc_gchat where id = m2));

  -- kręgi
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  j := myc_circle_create('Krąg testowy ' || substr(md5(random()::text), 1, 4), 'test', 5);
  cid := (j ->> 'id')::bigint; inv := j ->> 'invite';
  perform set_config('role', 'postgres', true);
  res := res || jsonb_build_object('invite_format', inv ~ '^KRG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$', 'invite_stored_plain', exists (select 1 from myc_circles where invite_hash = inv));
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('nonmember_get', pg_temp.t(format('select myc_circle_get(%s)::text', cid)));
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('join_bad', pg_temp.t($q$select myc_circle_join('KRG-AAAA-BBBB-CCCC')::text$q$));
  perform myc_circle_join(inv);
  perform myc_gchat_post('tajne w kręgu', null, null, '{}', cid);
  res := res || jsonb_build_object('member_sees_circle_msg', (select count(*) from myc_gchat where circle_id = cid));
  res := res || jsonb_build_object('vouch_low_trust', pg_temp.t(format('select myc_circle_vouch(%s, %L)::text', cid, h1)));
  res := res || jsonb_build_object('trust_new', (myc_trust_me() ->> 'trust')::real);
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  perform myc_acct_create('e2eout' || substr(md5(random()::text), 1, 6), null, null, null, 'e2e');
  res := res || jsonb_build_object('outsider_sees_circle_msg', (select count(*) from myc_gchat where circle_id = cid));
  res := res || jsonb_build_object('outsider_post_circle', pg_temp.t(format('select myc_gchat_post(%L, null, null, %L, %s)::text', 'x', '{}', cid)));
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  res := res || jsonb_build_object('anon_sees_circle_msg', (select count(*) from myc_gchat where circle_id = cid), 'anon_sees_global', (select count(*) from myc_gchat where room = 'e2e' and circle_id is null) > 0);
  res := res || jsonb_build_object('anon_circles_table', pg_temp.t($q$select count(*)::text from myc_circles$q$));
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('freeze', myc_circle_admin(cid, 'freeze', null, 'test') ->> 'ok');
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('post_frozen', pg_temp.t(format('select myc_gchat_post(%L, null, null, %L, %s)::text', 'po zamrożeniu', '{}', cid)));
  res := res || jsonb_build_object('member_freeze', pg_temp.t(format('select myc_circle_admin(%s, %L)::text', cid, 'unfreeze')));

  -- wzorce języka (ekstrakcja w e2e: k = 1 autor)
  perform set_config('role', 'postgres', true);
  res := res || jsonb_build_object('extract', myc_lang_extract(200, 'e2e'));
  res := res || jsonb_build_object('patterns', (select jsonb_agg(jsonb_build_array(kind, pattern, label) order by id) from myc_lang_patterns where room = 'e2e'));
  res := res || jsonb_build_object('handle_leak', exists (select 1 from myc_lang_patterns where room = 'e2e' and (pattern ilike '%' || h1 || '%' or example ilike '%' || h1 || '%' or pattern ilike '%example.com%')));
  select id into pid from myc_lang_patterns where room = 'e2e' and kind = 'skrót' and pattern = 'nwm';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('dev_vote', myc_lang_vote(null, gen_random_uuid(), pid, true));
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('optout', myc_gchat_set_train(false) ->> 'train_ok');
  perform set_config('role', 'postgres', true);
  res := res || jsonb_build_object('intent_samples_after_optout', (select count(*) from myc_lang_patterns p join myc_lang_src s on s.pattern_id = p.id where s.msg_id = m2 and p.status = 'pending'));
  res := res || jsonb_build_object('frag', (select jsonb_build_array(subj, rel, obj, status) from myc_frags where source_ref = 'lang:' || pid));
  res := res || jsonb_build_object('modlog_rows', (select count(*) from myc_mod_log where room = 'e2e'), 'ip_columns', (select count(*) from information_schema.columns where table_name in ('myc_gchat', 'myc_gchat_priv', 'myc_lang_patterns', 'myc_circles', 'myc_circle_members') and column_name ilike '%ip%'));
  raise exception 'RESULT %', res;
end $$;
