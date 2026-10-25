-- Publikacja wersji z węzła nasiennego (PyTorch na tych samych odłamkach; np. zmiana architektury).
-- Tylko właściciel bazy (bez grantu dla anon/authenticated). Ta sama bramka: stały test i trafność >= bieżącej.
create or replace function public.myc_publish_seed(p_model text, p_path text, p_acc real, p_val real, p_eval_n int, p_eval_sha text, p_meta jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare latest int; cur myc_models; es myc_eval_sets; why text;
begin
  perform pg_advisory_xact_lock(hashtext('myc_round:' || p_model));
  select max(version) into latest from myc_models where model = p_model;
  select * into cur from myc_models where model = p_model and version = latest;
  select * into es from myc_eval_sets where model = p_model;
  if p_path !~ ('^' || p_model || '/v' || (coalesce(latest, -1) + 1) || '-[0-9a-f]{8}\.bin$') then return jsonb_build_object('ok', false, 'reason', 'bad path'); end if;
  if not exists (select 1 from storage.objects where bucket_id = 'myc-models' and name = p_path) then return jsonb_build_object('ok', false, 'reason', 'weights not uploaded'); end if;
  if es.model is null or p_eval_n is distinct from es.n or p_eval_sha is distinct from es.sha then why := 'eval set mismatch';
  elsif cur.acc is not null and p_acc < cur.acc then why := format('regression %s < %s', round(p_acc::numeric, 4), round(cur.acc::numeric, 4));
  end if;
  if why is not null then
    insert into myc_model_rejections (model, version, acc, cur_acc, val_acc, eval_n, reason, meta)
      values (p_model, coalesce(latest, -1) + 1, p_acc, cur.acc, p_val, p_eval_n, why, coalesce(p_meta, '{}'));
    return jsonb_build_object('ok', false, 'reason', why);
  end if;
  insert into myc_models (model, version, path, acc, val_acc, n_updates, n_rejected, samples, flops, meta, created_by)
    values (p_model, coalesce(latest, -1) + 1, p_path, p_acc, p_val, 0, 0, coalesce((p_meta ->> 'samples')::bigint, 0),
            coalesce((p_meta ->> 'train_flops')::double precision, 0), coalesce(p_meta, '{}') || jsonb_build_object('eval_n', p_eval_n, 'gate_prev', cur.acc), null);
  update myc_jobs set status = 'expired' where model = p_model and version <= coalesce(latest, -1) and status in ('open', 'leased');
  update myc_results set status = 'rejected' where model = p_model and version <= coalesce(latest, -1) and status = 'pending';
  delete from myc_publish_lease where model = p_model;
  return jsonb_build_object('ok', true, 'version', coalesce(latest, -1) + 1);
end $$;
revoke all on function public.myc_publish_seed(text, text, real, real, int, text, jsonb) from public, anon, authenticated;
