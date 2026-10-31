-- Test portfela MYC-test (pokój e2e). Całość w jednej transakcji zakończonej wyjątkiem 'RESULT …' – Postgres
-- wycofuje wszystko (konta, księgę, bloki), w bazie nic nie zostaje. Klucze i podpisy liczy pgsodium (Ed25519).
-- Uruchomienie: python3 /tmp/q.py < supabase/tests/wallet_test.sql  → oczekiwane wartości w docs/wallet.md.
create or replace function pg_temp.t(q text) returns text language plpgsql as $f$
declare r text;
begin
  execute q into r;
  return coalesce(r, 'ok');
exception when others then return 'ERR: ' || sqlerrm;
end $f$;

do $$
declare u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); a1 uuid; a2 uuid;
  k1 pgsodium.crypto_sign_keypair; k2 pgsodium.crypto_sign_keypair; kn pgsodium.crypto_sign_keypair;
  p1 text; p2 text; pn text; res jsonb := '{}'; ts bigint; msg text; sig text; h int; b myc_wallet_blocks; pw bigint := 0;
  node uuid := gen_random_uuid(); bal1 bigint; bal2 bigint; q text;
begin
  insert into auth.users (id, aud, role, is_anonymous, instance_id) values
    (u1, 'authenticated', 'authenticated', true, '00000000-0000-0000-0000-000000000000'),
    (u2, 'authenticated', 'authenticated', true, '00000000-0000-0000-0000-000000000000');
  k1 := pgsodium.crypto_sign_seed_new_keypair(extensions.gen_random_bytes(32)); k2 := pgsodium.crypto_sign_seed_new_keypair(extensions.gen_random_bytes(32)); kn := pgsodium.crypto_sign_seed_new_keypair(extensions.gen_random_bytes(32));
  p1 := encode(k1.public, 'hex'); p2 := encode(k2.public, 'hex'); pn := encode(kn.public, 'hex');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  a1 := (myc_acct_create('e2ewal' || substr(md5(random()::text), 1, 6), null, null, null, 'e2e') ->> 'id')::uuid;
  perform set_config('role', 'postgres', true);
  sig := encode(pgsodium.crypto_sign_detached(convert_to('MYC-TEST/v1|register|' || a1 || '|' || p1, 'UTF8'), k1.secret), 'hex');
  perform set_config('role', 'authenticated', true);
  res := res || jsonb_build_object('reg_bad_sig', pg_temp.t(format('select myc_wallet_register(%L, %L)::text', p1, repeat('ab', 64))));
  res := res || jsonb_build_object('reg_ok', myc_wallet_register(p1, sig) ->> 'pub' = p1);
  res := res || jsonb_build_object('faucet', myc_wallet_faucet_claim() ->> 'balance');
  res := res || jsonb_build_object('faucet_again', pg_temp.t('select myc_wallet_faucet_claim()::text'));
  res := res || jsonb_build_object('direct_insert', pg_temp.t($q$insert into myc_wallet_tx (id, kind, to_pub, amount, nonce, ts_ms, prev_hash, hash) values (999999, 'mint', repeat('a', 64), 5, 0, 0, repeat('0', 64), repeat('1', 64)) returning 'inserted'$q$));
  res := res || jsonb_build_object('direct_bal', pg_temp.t($q$update myc_wallet_bal set balance = 99999 returning 'updated'$q$));

  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  a2 := (myc_acct_create('e2ewal' || substr(md5(random()::text), 1, 6), null, null, null, 'e2e') ->> 'id')::uuid;
  perform set_config('role', 'postgres', true);
  sig := encode(pgsodium.crypto_sign_detached(convert_to('MYC-TEST/v1|register|' || a2 || '|' || p2, 'UTF8'), k2.secret), 'hex');
  perform set_config('role', 'authenticated', true);
  res := res || jsonb_build_object('reg2', myc_wallet_register(p2, sig) ->> 'pub' = p2);
  res := res || jsonb_build_object('reg_steal_key', pg_temp.t(format('select myc_wallet_register(%L, %L)::text', p1, sig)));

  -- przelew 3,00 od 1 do 2 (nonce 1), podpisany kluczem 1
  perform set_config('role', 'postgres', true);
  ts := myc_wallet_now_ms();
  msg := myc_wallet_body('transfer', p1, p2, 300, 1, ts, 'test e2e żółw');
  sig := encode(pgsodium.crypto_sign_detached(convert_to(msg, 'UTF8'), k1.secret), 'hex');
  perform set_config('role', 'anon', true);
  q := format('select myc_wallet_send(%L, %L, %s, %s, %s, %L, %L)::text', p1, p2, 300, 1, ts, 'test e2e żółw', sig);
  res := res || jsonb_build_object('send', pg_temp.t(q) like '{"id"%');
  res := res || jsonb_build_object('replay', pg_temp.t(q));
  res := res || jsonb_build_object('tampered_amount', pg_temp.t(format('select myc_wallet_send(%L, %L, %s, %s, %s, %L, %L)::text', p1, p2, 900, 2, ts, 'test e2e żółw', sig)));
  res := res || jsonb_build_object('wrong_key', pg_temp.t(format('select myc_wallet_send(%L, %L, %s, %s, %s, %L, %L)::text', p2, p1, 300, 1, ts, 'test e2e żółw', sig)));
  -- podwójne wydanie: dwa podpisane przelewy z nonce 2 na całe saldo (700) – przejdzie tylko pierwszy
  perform set_config('role', 'postgres', true);
  sig := encode(pgsodium.crypto_sign_detached(convert_to(myc_wallet_body('transfer', p1, p2, 700, 2, ts, ''), 'UTF8'), k1.secret), 'hex');
  q := encode(pgsodium.crypto_sign_detached(convert_to(myc_wallet_body('transfer', p1, p2, 700, 2, ts + 1, ''), 'UTF8'), k1.secret), 'hex');
  perform set_config('role', 'anon', true);
  res := res || jsonb_build_object('spend_all', pg_temp.t(format('select myc_wallet_send(%L, %L, 700, 2, %s, %L, %L)::text', p1, p2, ts, '', sig)) like '{"id"%');
  res := res || jsonb_build_object('double_spend', pg_temp.t(format('select myc_wallet_send(%L, %L, 700, 2, %s, %L, %L)::text', p1, p2, ts + 1, '', q)));
  perform set_config('role', 'postgres', true);
  sig := encode(pgsodium.crypto_sign_detached(convert_to(myc_wallet_body('transfer', p1, p2, 1, 3, ts, ''), 'UTF8'), k1.secret), 'hex');
  perform set_config('role', 'anon', true);
  res := res || jsonb_build_object('overspend', pg_temp.t(format('select myc_wallet_send(%L, %L, 1, 3, %s, %L, %L)::text', p1, p2, ts, '', sig)));
  res := res || jsonb_build_object('old_ts', pg_temp.t(format('select myc_wallet_send(%L, %L, 1, 3, %s, %L, %L)::text', p1, p2, ts - 3600000, '', sig)));

  perform set_config('role', 'postgres', true);
  select balance into bal1 from myc_wallet_bal where pub = p1;
  select balance into bal2 from myc_wallet_bal where pub = p2;
  res := res || jsonb_build_object('bal1', bal1, 'bal2', bal2);
  -- łańcuch skrótów i blok
  res := res || jsonb_build_object('chain_ok', not exists (
    select 1 from myc_wallet_tx t join myc_wallet_tx p on p.id = t.id - 1 where t.prev_hash <> p.hash));
  h := myc_wallet_make_block();
  select * into b from myc_wallet_blocks where height = h;
  res := res || jsonb_build_object('block_ntx_ge3', b.n_tx >= 3, 'header_ok',
    b.hash = myc_wallet_sha(myc_wallet_header(b.height, b.prev_hash, b.merkle_root, b.first_id, b.last_id, b.n_tx, b.last_tx_hash, b.created_ms)));
  res := res || jsonb_build_object('tamper_tx', pg_temp.t($q$update myc_wallet_tx set amount = amount + 1 where id = (select max(id) from myc_wallet_tx) returning 'updated'$q$));
  res := res || jsonb_build_object('delete_tx', pg_temp.t($q$delete from myc_wallet_tx where id = (select max(id) from myc_wallet_tx) returning 'deleted'$q$));
  -- poświadczenie węzła: klucz, dowód pracy, podpis
  msg := 'MYC-TEST/v1|nodekey|' || node || '|' || pn;
  sig := encode(pgsodium.crypto_sign_detached(convert_to(msg, 'UTF8'), kn.secret), 'hex');
  perform set_config('role', 'anon', true);
  res := res || jsonb_build_object('nodekey', myc_node_key_register(node, pn, sig));
  perform set_config('role', 'postgres', true);
  while left(myc_wallet_sha(b.hash || '|' || pn || '|' || pw), 4) <> '0000' loop pw := pw + 1; end loop;
  sig := encode(pgsodium.crypto_sign_detached(convert_to('MYC-TEST/v1|attest|' || h || '|' || b.hash || '|1|' || node || '|' || pw, 'UTF8'), kn.secret), 'hex');
  q := encode(pgsodium.crypto_sign_detached(convert_to('MYC-TEST/v1|attest|' || h || '|' || b.hash || '|1|' || node || '|' || (pw + 1), 'UTF8'), kn.secret), 'hex');
  perform set_config('role', 'anon', true);
  res := res || jsonb_build_object('attest_no_pow', pg_temp.t(format('select myc_wallet_attest(%L, %s, %L, true, %L, %s, 3, 2, 1, %L, %L)::text', node, h, b.hash, '', pw + 1, 'cpu', q)));
  res := res || jsonb_build_object('attest', myc_wallet_attest(node, h, b.hash, true, '', pw, b.n_tx, 2, 1, 'cpu', sig));
  res := res || jsonb_build_object('final_with_one_new_node', (select final_at is not null from myc_wallet_blocks where height = h));
  raise exception 'RESULT %', res;
end $$;
