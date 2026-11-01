"""Samouk – grzybnia sama wybiera, czego się uczyć, i sama układa zadania (uruchamiane na boxie przez watchdog).

1. Mierzy opublikowaną wersję LM (i najnowszego kandydata, jeśli był trenowany według poprzedniego planu) na stałych
   zbiorach próbnych każdego typu (``samouk.probe`` – nigdy w treningu): trafność, średnie p poprawnej odpowiedzi.
2. Postęp nauki typu = trafność po treningu − trafność bazy. Gdy łączenie odrzuciło rundę lokalnie (brak kandydata),
   samouk sam składa jej aktualizacje (FedAvg, krok 1.0) z myc_results i mierzy: całość + osobno zadania danego typu.
3. ``samouk.choose`` (bandyta UCB) przydziela 9 z 12 zadań rundy; 3 zostają na Wikipedii.
4. Dla każdego typu układa nowe zadania (nowe ziarna; bez zbiorów próbnych, rundy 1 Ucz AI, puli kontrolnej i bez
   przecieku z bramki 2000 pytań – hash + 8-gramy), koduje je jak ``export_math_shard`` i zapisuje w myc_lm_self.
5. Zapisuje plan z uzasadnieniem do myc_lm_curriculum (czyta go koordynator rundy i strona).

Zapis przez Management API (SUPABASE_ACCESS_TOKEN właściciela; nic nie jest wypisywane). Bez zmian – wyjście.
Użycie: PYTHONPATH=src /workspace/.venv-kd/bin/python scripts/samouk_run.py [--force] [--threads 3] [--dry]
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
from export_lm_data import PAD  # noqa: E402
from export_math_shard import QWEN_SYS, held_out  # noqa: E402
from selfplay_run import TOK, TOK_REV, option_probs  # noqa: E402
from zadania_run import gate  # noqa: E402

from iot_mycelium.mesh import lm, samouk, selfplay  # noqa: E402
from iot_mycelium.mesh.net import SB_URL  # noqa: E402
from iot_mycelium.mesh.qwen import Qwen, ensure_weights  # noqa: E402

PROJECT = "agortpieeygmcttjwjfx"
LEX = ROOT / "web" / "public" / "data" / "rozbior" / "morf-lfg.json.gz"
SELF_JOBS, WIKI_JOBS, PER_TYPE, T = 9, 3, 256, 160


def sql(q: str):
    r = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
        data=json.dumps({"query": q}).encode(),
        headers={
            "Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
            "Content-Type": "application/json",
            "User-Agent": "myc-samouk",
        },  # fmt: skip
        method="POST",
    )
    return json.loads(urllib.request.urlopen(r, timeout=300).read())  # noqa: S310


def lit(x) -> str:
    return "'" + (x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)).replace("'", "''") + "'"


def adapter(path: str) -> lm.Lora:
    b = urllib.request.urlopen(f"{SB_URL}/storage/v1/object/public/myc-models/{path}", timeout=120).read()  # noqa: S310
    assert path.endswith(f"-{lm.sha256(b)[:8]}.bin")
    return lm.Lora.from_bytes(b)


def round_of(plan_id: int):
    """Aktualizacje z pierwszej rundy planu (gdy żadna nie czeka już na łączenie): [(typ | None, Lora, próbki)]."""
    rows = sql(
        "select r.id, j.params->'sft'->>'type' t, r.samples, r.status from myc_jobs j join myc_results r on r.job_id = j.id"  # noqa: S608 – wartości przez lit() (cudzysłowy podwojone), dane z programu
        " where j.model = 'lm' and j.kind = 'train'"
        # pierwsza runda planu (zadania samouka + Wikipedia, wspólny created_at); kolejna z tym planem mogła już ruszyć
        " and j.created_at = (select min(created_at) from myc_jobs where model = 'lm' and kind = 'train'"
        f" and params->>'plan' = {lit(str(plan_id))}) order by r.id"
    )
    if len(rows) < 3 or any(r["status"] == "pending" for r in rows):
        return None
    out = []
    for i in range(0, len(rows), 3):
        part = rows[i : i + 3]
        got = sql(f"select id, payload from myc_results where id in ({','.join(str(int(r['id'])) for r in part)})")  # noqa: S608 – liczby
        pay = {g["id"]: g["payload"] for g in got}
        for r in part:
            if pay.get(r["id"]):
                u = lm.Lora.from_bytes(base64.b64decode(pay[r["id"]]))
                if u.finite():
                    out.append((r["t"], u, float(r["samples"] or 1)))
    return out or None


def measure(m, tok, lora: lm.Lora, probes: dict[str, list[samouk.MC]]) -> dict[str, dict]:
    m.lora = lm.runtime(lora, m.dtype)
    out = {}
    for t, items in probes.items():
        ok, pr = 0, []
        for i, it in enumerate(items):
            p = option_probs(m, tok, f"s{t}{i}", it.prompt, list(it.options))
            ok += int(np.argmax(p)) == it.answer
            pr.append(float(p[it.answer]))
        out[t] = {"acc": round(ok / len(items), 4), "p_right": round(sum(pr) / len(pr), 4), "n": len(items)}
    return out


def encode(tok, q: str, ans: str):
    head = f"<|im_start|>system\n{QWEN_SYS}<|im_end|>\n<|im_start|>user\n{q}<|im_end|>\n<|im_start|>assistant\n"
    a = tok(head, add_special_tokens=False).input_ids
    b = tok(ans + "<|im_end|>", add_special_tokens=False).input_ids
    if len(a) + len(b) > T:
        return None
    n = len(a) + len(b)
    return a + b + [PAD] * (T - n), [0] * len(a) + [1] * len(b) + [0] * (T - n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--threads", type=int, default=3)
    a = ap.parse_args()
    base = sql("select version, path from myc_models where model='lm' order by version desc limit 1")[0]
    plans = sql("select id, at, measured, stats, alloc from myc_lm_curriculum order by id")
    last = plans[-1] if plans else None
    cand = sql(
        "select id, path, status from myc_candidates where model='lm' and meta->>'algo' like '%self-%'"  # noqa: S608 – wartości przez lit() (cudzysłowy podwojone), dane z programu
        + (f" and created_at > {lit(last['at'])}" if last else "")
        + " order by id desc limit 1"
    )
    cand = cand[0] if cand else None
    rnd = round_of(last["id"]) if last and not cand else None
    fresh = last and time.time() - time.mktime(time.strptime(last["at"][:19], "%Y-%m-%d %H:%M:%S")) < 6 * 3600
    if (
        last
        and not a.force
        and not cand
        and not rnd
        and last["measured"]["base"]["version"] == base["version"]
        and fresh
    ):
        print("samouk: bez zmian (ta sama wersja, brak nowego kandydata)")
        return
    t0 = time.time()
    forms = samouk.noun_forms(LEX)
    gh, gng, gsha, _ = gate()
    probes = {t: samouk.probe(t, forms, gng) for t in samouk.TYPES}
    probe_sha = lm.sha256(json.dumps({t: [x.sha for x in v] for t, v in probes.items()}).encode())
    from transformers import AutoTokenizer

    torch.set_num_threads(a.threads)
    tok = AutoTokenizer.from_pretrained(TOK, revision=TOK_REV)
    m = Qwen(ensure_weights(print), torch.bfloat16)
    if (
        last
        and last["measured"]["base"]["version"] == base["version"]
        and last["measured"].get("probe_sha") == probe_sha
    ):
        bstats = {t: {k: s[k] for k in ("acc", "p_right", "n")} for t, s in last["stats"].items()}
    else:
        bstats = measure(m, tok, adapter(base["path"]), probes)
    cstats = measure(m, tok, adapter(cand["path"]), probes) if cand else None
    tstats = {}
    if rnd:
        # runda odrzucona lokalnie: całość (FedAvg) i osobno aktualizacje z zadań danego typu, na zbiorze próbnym tego typu
        cstats = measure(m, tok, lm.Lora.average([(u, w) for _, u, w in rnd]), probes)
        for t in samouk.TYPES:
            us = [(u, w) for tt, u, w in rnd if tt == t]
            if us:
                tstats[t] = measure(m, tok, lm.Lora.average(us), {t: probes[t]})[t]
    rounds = {t: sum(int((p["alloc"] or {}).get(t, 0)) for p in plans) for t in samouk.TYPES}
    stats = {}
    for t in samouk.TYPES:
        prog = None
        if t in tstats:
            prog = round(tstats[t]["acc"] - bstats[t]["acc"], 4)
        elif cstats and last and int(last["alloc"].get(t, 0)) > 0:
            prog = round(cstats[t]["acc"] - bstats[t]["acc"], 4)
        elif last and t in last["stats"]:
            prog = last["stats"][t].get("progress")
        stats[t] = {**bstats[t], "progress": prog, **({"cand_acc": cstats[t]["acc"]} if cstats else {}),
                    **({"type_acc": tstats[t]["acc"], "type_p_right": tstats[t]["p_right"]} if t in tstats else {})}  # fmt: skip
    pick = samouk.choose(stats, SELF_JOBS, rounds)
    # nowe zadania: ziarna zależne od numeru planu, poza próbami/rundą 1/pulą kontrolną/bramką
    excl = {x.sha for v in probes.values() for x in v} | held_out(24) | gh
    stamp = time.strftime("%Y%m%d-%H%M", time.gmtime())
    k = (last["id"] if last else 0) + 1
    shards = []
    for i, t in enumerate(samouk.TYPES):
        items = samouk.generate(t, PER_TYPE, 10_000 + 1000 * k + i, exclude=excl, gate_ngrams=gng, forms=forms)
        ids, mask = [], []
        for it in items:
            if selfplay.qhash(it.prompt) in gh:
                continue
            c = encode(tok, it.prompt, it.options[it.answer])
            if c:
                ids.append(c[0])
                mask.append(c[1])
        info = {"kind": f"self-{t}", "source": "zadania ułożone programem przez samouka (mesh/samouk.py)",
                "plan": k, "gate_eval_sha": gsha, "probe_sha": probe_sha, "license": "dane generowane programem"}  # fmt: skip
        b = gzip.compress(lm.pack_data(info, torch.tensor(ids), torch.tensor(mask)), 6, mtime=0)
        shards.append({"type": t, "name": f"self-{t}-{stamp}.bin.gz", "sha256": lm.sha256(b), "n": len(ids), "_b": b})
    measured = {"base": base, "cand": cand and {"id": cand["id"], "path": cand["path"], "status": cand["status"]},
                "probe_sha": probe_sha, "s": round(time.time() - t0, 1),
                "round": rnd and {"plan": last["id"], "updates": len(rnd), "cand": cstats}}  # fmt: skip
    print(json.dumps({"alloc": pick["alloc"], "stats": stats}, ensure_ascii=False))
    if a.dry:
        return
    for s in shards:
        b = s.pop("_b")
        sql(
            "insert into myc_lm_self (name, type, sha256, bytes, n, data) values ("  # noqa: S608 – wartości przez lit() (cudzysłowy podwojone), dane z programu
            f"{lit(s['name'])}, {lit(s['type'])}, {lit(s['sha256'])}, {len(b)}, {s['n']}, {lit(base64.b64encode(b).decode())})"
            " on conflict (name) do nothing"
        )
    sql(
        "insert into myc_lm_curriculum (measured, stats, alloc, why, shards, wiki_jobs, probe) values ("  # noqa: S608 – wartości przez lit() (cudzysłowy podwojone), dane z programu
        f"{lit(measured)}, {lit(stats)}, {lit(pick['alloc'])}, {lit(pick['why'])}, {lit(shards)}, {WIKI_JOBS}, "
        f"{lit({'seed': samouk.PROBE_SEED, 'n': samouk.PROBE_N, 'sha': probe_sha})})"
    )
    sql("select myc_samouk_gc()")
    print("samouk: zapisano plan", k)


if __name__ == "__main__":
    main()
