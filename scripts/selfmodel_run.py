#!/usr/bin/env python3
"""SelfModel: zbiera prawdziwe pomiary, kalibruje pewność, formułuje twierdzenia o sobie i sprawdza poprzednie.

Uruchamiany po każdym przebiegu samouka (watchdog na boxie, myc-nodes/samouk.sh). Wejścia:
  * stały test LM (2000 pytań, eval.bin) – wyniki opcji bieżącej wersji (liczone raz na wersję, pamięć podręczna),
  * pytania próbne samouka (myc_lm_curriculum; rozkład na opcjach z ``measured.items`` albo policzony tu raz),
  * testy szkolne czystej grzybni (data/szkolne/wyniki.json ze strony demo, z „nie wiem”),
  * plany samouka jako historia decyzji i ich skutków.
Temperatura dopasowana na parzystych pytaniach testu LM; ECE przed/po na nieparzystych i na pytaniach samouka.
Nowa migawka trafia do myc_self_model tylko przy zmianie wejść. Zapis przez Management API (SUPABASE_ACCESS_TOKEN
właściciela; nic nie jest wypisywane).

  PYTHONPATH=src /workspace/.venv-kd/bin/python scripts/selfmodel_run.py [--dry] [--json out.json] [--threads 2]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from iot_mycelium.mesh.net import SB_KEY, SB_URL  # noqa: E402
from iot_mycelium.mesh.qwen import cache_dir  # noqa: E402
from iot_mycelium.selfmodel.model import MeasuredSelfModel, decisions_from_plans  # noqa: E402
from iot_mycelium.selfmodel.sources import lm_eval_measurement, samouk_measurements, school_measurements  # noqa: E402
from iot_mycelium.selfmodel.store import SupabaseSelfStore  # noqa: E402

PROJECT = "agortpieeygmcttjwjfx"
DEMO = "https://maciejsearch-cloud.github.io/demo/mycelium"


def rest(q: str):
    h = {"apikey": SB_KEY, "User-Agent": "myc-selfmodel"}
    r = urllib.request.Request(f"{SB_URL}/rest/v1/{q}", headers=h)  # noqa: S310 – stały adres https projektu
    with urllib.request.urlopen(r, timeout=120) as f:  # noqa: S310 – stały adres https projektu
        return json.loads(f.read())


def sql(q: str):
    r = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
        data=json.dumps({"query": q}).encode(),
        headers={
            "Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
            "Content-Type": "application/json",
            "User-Agent": "myc-selfmodel",
        },  # fmt: skip
        method="POST",
    )
    return json.loads(urllib.request.urlopen(r, timeout=300).read())  # noqa: S310


def relations_status() -> dict:
    """Punkt rozszerzenia „relacje”: pamięć relacji z użytkownikami (myc_self_relations, osobny moduł czatu).

    Do publicznej migawki trafia tylko informacja, czy tabela istnieje i ile wierszy widzi klucz publiczny –
    nigdy treść relacji (to dane osobiste; czyta je tylko ich właściciel przez RLS)."""
    try:
        r = urllib.request.Request(  # noqa: S310 – stały adres https projektu
            f"{SB_URL}/rest/v1/myc_self_relations?select=*&limit=0",
            headers={"apikey": SB_KEY, "Prefer": "count=exact", "User-Agent": "myc-selfmodel"},
        )
        with urllib.request.urlopen(r, timeout=30) as f:  # noqa: S310
            rng = f.headers.get("Content-Range", "*/0")
        return {"source": "myc_self_relations", "available": True, "public_rows": int(rng.split("/")[-1] or 0)}
    except (OSError, ValueError):
        return {"source": "myc_self_relations", "available": False, "public_rows": 0}


def wyniki() -> dict:
    try:
        with urllib.request.urlopen(f"{DEMO}/data/szkolne/wyniki.json", timeout=60) as f:  # noqa: S310
            return json.loads(f.read())
    except OSError:
        return json.loads((ROOT / "web/public/data/szkolne/wyniki.json").read_text())


class Lazy:
    """Model bazowy ładowany dopiero, gdy trzeba coś policzyć (zwykle raz na nową wersję LM)."""

    def __init__(self, threads: int) -> None:
        self.threads, self._m = threads, None

    def get(self):
        if self._m is None:
            import torch

            from iot_mycelium.mesh.qwen import Qwen, ensure_weights

            torch.set_num_threads(self.threads)
            self._m = Qwen(ensure_weights(print), torch.bfloat16)
        return self._m


def lm_scores(lazy: Lazy, ver: dict, eval_sha: str) -> tuple[list, list]:
    p = cache_dir() / "selfmodel" / f"lm-v{ver['version']}-{eval_sha[:16]}.json"
    if p.exists():
        d = json.loads(p.read_text())
        return d["scores"], d["answers"]
    from samouk_run import adapter

    from iot_mycelium.mesh import lm
    from iot_mycelium.mesh.lmwork import Data
    from iot_mycelium.selfmodel.lmscores import mc_scores

    eb = Data().eval_bytes()
    if lm.sha256(eb) != eval_sha:
        raise SystemExit("eval.bin: SHA-256 niezgodny z myc_eval_sets")
    t0 = time.time()
    s, a = mc_scores(lazy.get(), adapter(ver["path"]).roundtrip(), eb)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"version": ver["version"], "eval_sha": eval_sha, "scores": s, "answers": a,
                             "backend": "torch-bf16", "s": round(time.time() - t0, 1)}))  # fmt: skip
    print(f"selfmodel: wyniki opcji LM v{ver['version']} policzone ({len(s)} pytań, {time.time() - t0:.0f} s)")
    return s, a


def probe_items(lazy: Lazy, plan: dict, ver: dict) -> dict | None:
    """Rozkład na opcjach pytań próbnych dla wersji z planu: z planu, z pamięci podręcznej albo policzony raz."""
    it = plan["measured"].get("items")
    if it:
        return it
    if plan["measured"]["base"]["version"] != ver["version"]:
        return None
    sha = plan["measured"].get("probe_sha") or ""
    p = cache_dir() / "selfmodel" / f"probe-v{ver['version']}-{sha[:16]}.json"
    if p.exists():
        return json.loads(p.read_text())
    import samouk_run
    from transformers import AutoTokenizer

    from iot_mycelium.mesh import lm, samouk

    forms = samouk.noun_forms(samouk_run.LEX)
    _, gng, _, _ = samouk_run.gate()
    probes = {t: samouk.probe(t, forms, gng) for t in samouk.TYPES}
    got = lm.sha256(json.dumps({t: [x.sha for x in v] for t, v in probes.items()}).encode())
    if got != sha:
        print("selfmodel: zbiór próbny zmienił się od planu – pomijam rozkład pytań próbnych")
        return None
    tok = AutoTokenizer.from_pretrained(samouk_run.TOK, revision=samouk_run.TOK_REV)
    items: dict = {}
    samouk_run.measure(lazy.get(), tok, samouk_run.adapter(ver["path"]), probes, items)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(items))
    return items


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry", action="store_true", help="bez zapisu do bazy")
    ap.add_argument("--json", help="zapisz migawkę do pliku")
    ap.add_argument("--threads", type=int, default=2)
    a = ap.parse_args()
    ver = rest("myc_models?model=eq.lm&order=version.desc&limit=1&select=version,path,acc,meta")[0]
    eval_sha = rest("myc_eval_sets?model=eq.lm&select=sha")[0]["sha"]
    plans = rest("myc_lm_curriculum?select=id,at,stats,alloc,why,wiki_jobs,measured&order=id.asc")
    lazy = Lazy(a.threads)
    scores, answers = lm_scores(lazy, ver, eval_sha)
    now = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
    lm_m, rep = lm_eval_measurement(scores, answers, ver["version"], eval_sha, now)
    ms, reps = [lm_m], {"lm/definicje": rep}
    plan = plans[-1] if plans else None
    if plan:
        sm_ms, sm_reps = samouk_measurements(plan, probe_items(lazy, plan, ver))
        ms += sm_ms
        reps.update(sm_reps)
    ms += school_measurements(wyniki())
    meta = ver.get("meta") or {}
    state = {"lm": {"version": ver["version"], "base": meta.get("base", "Qwen2.5-0.5B-Instruct"),
                    "rank": meta.get("rank"), "params": meta.get("params"), "acc": ver.get("acc"),
                    "ppl": meta.get("ppl"), "decided_by": meta.get("decided_by")},
             "czysta": {"model": (wyniki().get("runs") or [{}])[-1].get("model")}}  # fmt: skip
    keep = ("n", "correct", "conf_raw", "conf_cal", "ece_raw", "ece_cal", "reliability_raw", "reliability_cal",
            "held_out", "n_held_out", "params")  # fmt: skip
    calib = {"params": rep["params"], "lm_definicje": {k: rep[k] for k in keep},
             "domains": {d: {k: r[k] for k in keep} for d, r in reps.items()}}  # fmt: skip
    sm = MeasuredSelfModel(state=state, calibration=calib, plan=plan, at=now, relations=relations_status())
    sm.observe(ms)
    sm.record(decisions_from_plans(plans))
    store = SupabaseSelfStore(SB_URL, SB_KEY, None if a.dry else sql)
    prev = store.latest()
    if prev and prev.fingerprint == sm.fingerprint() and not a.json:
        print("selfmodel: bez zmian")
        return 0
    sm.check(prev)
    snap = sm.snapshot()
    j = snap.to_json()
    if a.json:
        Path(a.json).write_text(json.dumps(j, ensure_ascii=False, indent=1))
    verdicts: dict[str, int] = {}
    for c in snap.checks:
        verdicts[c.verdict.value] = verdicts.get(c.verdict.value, 0) + 1
    print(f"selfmodel: T={rep['params']['T']}, ECE {rep['ece_raw']:.3f} → {rep['ece_cal']:.3f}, {len(snap.claims)} twierdzeń, "
          f"kontrole {verdicts}")  # fmt: skip
    if not a.dry and (not prev or prev.fingerprint != snap.fingerprint):
        print("selfmodel: zapisano" if store.save(snap) else "selfmodel: migawka już była")
    return 0


if __name__ == "__main__":
    sys.exit(main())
