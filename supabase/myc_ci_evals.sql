-- Niezależna ponowna ocena każdej wersji przez GitHub Actions (scripts/verify_model.py, numpy).
-- Wyniki publiczne do odczytu; zapis tylko przez RPC z kluczem CI (w tabeli tylko skrót klucza).
create table if not exists public.myc_ci_evals (
  model text not null,
  version int not null,
  acc_stored real,
  acc_recomputed real not null check (acc_recomputed between 0 and 1),
  diff_pp real not null,
  eval_n int not null,
  eval_sha text not null check (eval_sha ~ '^[0-9a-f]{64}$'),
  eval_sha_ok boolean not null,
  weights_sha text not null check (weights_sha ~ '^[0-9a-f]{64}$'),
  n_params int not null,
  ok boolean not null,
  run_url text check (run_url is null or run_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+$'),
  created_at timestamptz not null default now(),
  primary key (model, version)
);
create table if not exists public.myc_ci_keys (key_hash text primary key, label text not null);
alter table public.myc_ci_evals enable row level security;
alter table public.myc_ci_keys enable row level security;
revoke all on public.myc_ci_evals, public.myc_ci_keys from anon, authenticated;
grant select on public.myc_ci_evals to anon, authenticated;
drop policy if exists myc_ci_evals_read on public.myc_ci_evals;
create policy myc_ci_evals_read on public.myc_ci_evals for select using (true);

create or replace function public.myc_ci_eval(p_key text, p_rows jsonb, p_run_url text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; n int := 0;
begin
  if not exists (select 1 from myc_ci_keys where key_hash = encode(sha256(convert_to(p_key, 'utf8')), 'hex')) then
    raise exception 'myc: zły klucz CI' using errcode = '42501';
  end if;
  if jsonb_array_length(p_rows) > 200 then raise exception 'myc: za dużo wierszy'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    -- tylko istniejące wersje
    if exists (select 1 from myc_models m where m.model = r->>'model' and m.version = (r->>'version')::int) then
      insert into myc_ci_evals (model, version, acc_stored, acc_recomputed, diff_pp, eval_n, eval_sha, eval_sha_ok, weights_sha, n_params, ok, run_url)
      values (r->>'model', (r->>'version')::int, (r->>'acc_stored')::real, (r->>'acc_recomputed')::real, (r->>'diff_pp')::real,
              (r->>'eval_n')::int, r->>'eval_sha256', (r->>'eval_sha_matches_db')::boolean, r->>'weights_sha256', (r->>'n_params')::int,
              (r->>'ok')::boolean, p_run_url)
      on conflict (model, version) do update set acc_recomputed = excluded.acc_recomputed, diff_pp = excluded.diff_pp, ok = excluded.ok,
        eval_sha_ok = excluded.eval_sha_ok, weights_sha = excluded.weights_sha, run_url = excluded.run_url, created_at = now();
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.myc_ci_eval(text, jsonb, text) from public;
grant execute on function public.myc_ci_eval(text, jsonb, text) to anon, authenticated;
