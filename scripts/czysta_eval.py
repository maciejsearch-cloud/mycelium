"""Pomiar czystej grzybni (zakładka „Czysta grzybnia”, web/src/myc/czysta.ts + czystaWiedza.ts).

Zadania: te same 320 zadań logicznych co pomiar rozumującego (selfplay seed 2, n 320, poziom 1; scripts/logika_eval.py)
oraz 40 pytań chat_facts_v1 (benchmarks/chat_facts). Ocena: selfplay.check (logika) i dopasowanie `accept` (fakty).

  PYTHONPATH=src python3 scripts/czysta_eval.py --model /ścieżka/v3.bin [--url http://localhost:4173/demo/mycelium/]

1) node web/scripts/czysta-eval.mjs – kod TS bez przeglądarki, BEZ wiedzy z bazy (tylko przesłanki z pytania);
   porównanie 1:1 z rozumującym w Pythonie (logika.Reasoner) na tym samym modelu rozbioru.
2) --url: Playwright na zbudowanej stronie (e2e-eval/czysta.spec.ts) – z wiedzą zatwierdzoną przez ludzi, tak jak widzi to
   użytkownik. Ten wynik trafia do web/public/data/czysta/wyniki.json (tabela na stronie).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from iot_mycelium.mesh import selfplay  # noqa: E402

FACTS = json.loads((ROOT / "benchmarks/chat_facts/chat_facts_v1.json").read_text())["items"]


def score_logic(tasks, res):
    per = defaultdict(lambda: {"n": 0, "correct": 0, "abstain": 0})
    for t, r in zip(tasks, res, strict=True):
        p = per[t.kind]
        p["n"] += 1
        p["correct"] += bool(r["answer"] is not None and selfplay.check(t, r["answer"]))
        p["abstain"] += r["answer"] is None
    for p in per.values():
        p["acc"] = round(p["correct"] / p["n"], 4)
    n = sum(p["n"] for p in per.values())
    c = sum(p["correct"] for p in per.values())
    a = sum(p["abstain"] for p in per.values())
    return {"n": n, "correct": c, "abstain": a, "acc": round(c / n, 4), "per_category": dict(sorted(per.items()))}


def score_facts(res):
    out = {"n": len(FACTS), "correct": 0, "abstain": 0, "wrong": 0, "rows": []}
    for it, r in zip(FACTS, res, strict=True):
        a = r["answer"]
        if a is None:
            v = "dont_know"
        elif any(re.search(x, a, re.I) for x in it.get("accept", [])):
            v = "correct"
        else:
            v = "wrong"
        out[{"dont_know": "abstain", "correct": "correct", "wrong": "wrong"}[v]] += 1
        out["rows"].append({"id": it["id"], "q": it["q"], "answer": a, "verdict": v, "source": r.get("source")})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="plik wag rozbioru (ten sam co opublikowany na stronie)")
    ap.add_argument("--url", help="adres zbudowanej strony do pomiaru w przeglądarce")
    ap.add_argument("--python", action="store_true", help="porównaj z logika.Reasoner w Pythonie")
    a = ap.parse_args()
    tasks = selfplay.generate(320, 2)
    items = [{"id": f"l{i}", "q": t.question} for i, t in enumerate(tasks)] + [
        {"id": f["id"], "q": f["q"]} for f in FACTS
    ]
    tmp = Path(tempfile.mkdtemp(prefix="czysta-"))
    (tmp / "in.json").write_text(json.dumps({"model": a.model, "items": items}, ensure_ascii=False))
    subprocess.run(
        ["node", "scripts/czysta-eval.mjs", str(tmp / "in.json"), str(tmp / "node.json")], cwd=ROOT / "web", check=True
    )
    node = json.loads((tmp / "node.json").read_text())["results"]
    rep = {
        "when": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "model": Path(a.model).name,
        "tasks": "selfplay.generate(320, 2) + chat_facts_v1",
        "node_no_kb": {"logic": score_logic(tasks, node[:320]), "chat_facts": score_facts(node[320:])},
        "python_same": None,
    }
    if a.python:
        from iot_mycelium.rozbior import logika

        R = logika.Reasoner(logika.Parser(a.model, str(ROOT / "web/public/data/rozbior/morf.json.gz")))
        diff = [i for i, t in enumerate(tasks) if R.answer(t.question) != node[i]["answer"]]
        rep["python_same"] = not diff
        rep["python_diff"] = len(diff)
    if a.url:
        env = {
            **os.environ,
            "EVAL_URL": a.url,
            "CZYSTA_ITEMS": str(tmp / "in.json"),
            "CZYSTA_OUT": str(tmp / "web.json"),
        }
        subprocess.run(
            ["npx", "playwright", "test", "-c", "playwright.eval.config.ts", "czysta"],
            cwd=ROOT / "web",
            env=env,
            check=True,
        )
        web = json.loads((tmp / "web.json").read_text())
        rep["browser"] = {
            "url": a.url,
            "model": web["model"],
            "logic": score_logic(tasks, web["results"][:320]),
            "chat_facts": score_facts(web["results"][320:]),
        }
        rep["browser_vs_node_logic_diff"] = sum(
            1 for x, y in zip(web["results"][:320], node[:320], strict=True) if x["answer"] != y["answer"]
        )
    out = ROOT / f"results/czysta/{rep['when'][:16].replace(':', '').replace('T', '-')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rep, ensure_ascii=False, indent=1))
    src = rep.get("browser") or rep["node_no_kb"]
    pub = {
        "when": rep["when"],
        "model": src.get("model", rep["model"]).split("(")[0].replace("rozbiór: ", "").strip() or rep["model"],
        "logic": src["logic"],
        "chat_facts": {k: v for k, v in src["chat_facts"].items() if k != "rows"},
        "python_same": rep["python_same"],
    }
    (ROOT / "web/public/data/czysta").mkdir(parents=True, exist_ok=True)
    (ROOT / "web/public/data/czysta/wyniki.json").write_text(json.dumps(pub, ensure_ascii=False, indent=1))
    for k in ("node_no_kb", "browser"):
        if k in rep:
            L, F = rep[k]["logic"], rep[k]["chat_facts"]
            print(
                f"{k}: logika {L['correct']}/{L['n']} ({L['acc']:.1%}), „nie wiem” {L['abstain']}; fakty {F['correct']}/{F['n']}, „nie wiem” {F['abstain']}, błędne {F['wrong']}"
            )
    print("python_same:", rep["python_same"], "→", out)


if __name__ == "__main__":
    main()
