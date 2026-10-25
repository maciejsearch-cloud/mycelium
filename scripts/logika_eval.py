"""Pomiar kroku 3 (roles→logic): te same zadania co pomiar LM v1 z #75 (selfplay seed 2, n 320, poziom 1)
+ poziomy 2–3 + zamrożone parafrazy (results/logika/parafrazy-v1.json). Bramka 2000 pytań nie jest tu czytana ani zmieniana.

  PYTHONPATH=src PY scripts/logika_eval.py
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from iot_mycelium.mesh import selfplay  # noqa: E402
from iot_mycelium.rozbior import logika  # noqa: E402

BIN = "/workspace/data/rozbior/rb-v0.bin"
LEX = str(ROOT / "web/public/data/rozbior/morf.json.gz")
LM = json.loads((ROOT / "results/selfplay/20261025-0040.json").read_text())


def run(R, items):
    per = defaultdict(lambda: {"n": 0, "correct": 0, "abstain": 0})
    rows = []
    for kind, q, gold, chk in items:
        a = R.answer(q)
        ok = a is not None and chk(a)
        p = per[kind]
        p["n"] += 1
        p["correct"] += ok
        p["abstain"] += a is None
        rows.append({"kind": kind, "q": q, "gold": gold, "got": a, "ok": ok})
    for p in per.values():
        p["acc"] = round(p["correct"] / p["n"], 4)
    n = sum(p["n"] for p in per.values())
    c = sum(p["correct"] for p in per.values())
    return {"n": n, "correct": c, "acc": round(c / max(n, 1), 4), "per_category": dict(sorted(per.items()))}, rows


def task_items(tasks):
    return [(t.kind, t.question, t.answer, (lambda a, t=t: selfplay.check(t, a))) for t in tasks]


def main():
    t0 = time.time()
    R = logika.Reasoner(logika.Parser(BIN, LEX))
    tasks = selfplay.generate(320, 2)
    cnt = Counter(t.kind for t in tasks)
    same = all(cnt.get(k, 0) == v["n"] for k, v in LM["per_category"].items())
    lv1, rows1 = run(R, task_items(tasks))
    for k, v in lv1["per_category"].items():
        lm = LM["per_category"].get(k, {})
        v["lm_v1"], v["baseline"] = lm.get("acc"), lm.get("baseline")
    hard = selfplay.generate(
        320,
        2,
        levels={k: 3 for k in selfplay.CATEGORIES},
        kinds=[k for k in selfplay.CATEGORIES if selfplay.MAX_LEVEL.get(k, 1) > 1],
    )
    lv3, rows3 = run(R, task_items(hard))
    fresh, _rowsf = run(
        R, task_items(selfplay.generate(320, 7))
    )  # nowe wylosowanie szablonów (seed nieużywany przy pisaniu)
    para = json.loads((ROOT / "results/logika/parafrazy-v1.json").read_text())["items"]

    def pchk(gold):
        if gold in ("tak", "nie", "nie wiadomo"):
            t = selfplay.Task("x", "", gold)
            return lambda a: selfplay.check(t, a)
        return lambda a: selfplay.norm(a) == selfplay.norm(gold)  # imiona spoza szablonów: check() zna tylko PEOPLE

    pp, rowsp = run(R, [(i["kind"], i["q"], i["a"], pchk(i["a"])) for i in para])
    rep = {
        "when": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "parser": "rozbiór v0 (MYCRB2) + leksykon Morfeusza z przeglądarki",
        "same_tasks_as_lm_v1": same,
        "level1_seed2_n320": lv1,
        "lm_v1": {"acc": LM["acc"], "n": LM["n"], "when": LM["when"]},
        "level_max_seed2": lv3,
        "level1_seed7_n320_fresh": fresh,
        "paraphrases_v1": pp,
        "paraphrases_v1_first_run": {
            "correct": 29,
            "n": 56,
            "note": "pierwszy przebieg, przed poprawkami reguł na zadaniach z szablonów",
        },
        "note": "Reguły pisane ze znajomością szablonów selfplay; parafrazy zamrożone przed regułami (commit 746aa77), "
        "odpowiedzi parafraz ustalone przez autora (agent), bez weryfikacji ludzi. Wstrzymanie (None) = błąd.",
        "seconds": round(time.time() - t0, 1),
    }
    out = ROOT / "results/logika/eval.json"
    out.write_text(json.dumps(rep, ensure_ascii=False, indent=1))
    (ROOT / "results/logika/eval-rows.json").write_text(
        json.dumps({"level1": rows1, "level_max": rows3, "paraphrases": rowsp}, ensure_ascii=False, indent=0)
    )
    print(f"te same zadania co LM v1: {same}")
    print(f"świeże szablony (seed 7): {fresh['acc']}")
    print(
        f"poziom 1: {lv1['acc']} (LM v1 {LM['acc']}); poziom max: {lv3['acc']}; parafrazy: {pp['acc']} ({pp['correct']}/{pp['n']})"
    )
    for k, v in lv1["per_category"].items():
        print(
            f"  {k:20s} {v['correct']:3d}/{v['n']:3d} = {v['acc']:.3f}  wstrzym. {v['abstain']:3d}  LM v1 {v['lm_v1']}  stała {v['baseline']}"
        )
    print("parafrazy:")
    for k, v in pp["per_category"].items():
        print(f"  {k:20s} {v['correct']}/{v['n']}  wstrzym. {v['abstain']}")


if __name__ == "__main__":
    main()
