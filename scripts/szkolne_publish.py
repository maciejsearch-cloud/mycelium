"""Publikuje pomiar testów szkolnych do web/public/data/szkolne/wyniki.json (widok „Testy szkolne” w zakładce Czysta grzybnia).

Bierze z results/szkolne/ pomiary zamrożonego zestawu na żywej stronie: czystej grzybni (czysta_browser, etykiety
„przed” i kolejne) i LM grzybni (lm_browser), jeśli taki pomiar istnieje. Nic nie dopisuje od siebie: brak pliku = brak
wiersza w widoku.

  python3 scripts/szkolne_publish.py [--lm-note "dlaczego brak pomiaru LM"]
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SET = ROOT / "benchmarks/szkolne/szkolne_v1.json"
OUT = ROOT / "web/public/data/szkolne/wyniki.json"


def run_summary(p: Path, rep: dict) -> dict:
    cats: dict[str, dict[str, int]] = defaultdict(lambda: {"n": 0, "ok": 0, "zle": 0, "nie_wiem": 0})
    for r in rep["rows"]:
        c = cats[r["category"]]
        c["n"] += 1
        c[r["verdict"]] += 1
    keys = ("when", "label", "mode", "url", "n", "ok", "zle", "nie_wiem", "per_grade")
    return {**{k: rep.get(k) for k in keys}, "file": str(p.relative_to(ROOT)), "per_category": dict(sorted(cats.items()))}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lm-note", default=None)
    a = ap.parse_args()
    data = json.loads(SET.read_text())
    reps = []
    for p in sorted((ROOT / "results/szkolne").glob("*.json")):
        rep = json.loads(p.read_text())
        if rep.get("set") == data["set"] and rep.get("url") and rep.get("mode") in ("czysta_browser", "lm_browser"):
            reps.append((p, rep))
    reps.sort(key=lambda x: x[1]["when"])
    pure = [(p, r) for p, r in reps if r["mode"] == "czysta_browser"]
    lm = [(p, r) for p, r in reps if r["mode"] == "lm_browser"]
    res: dict[str, dict] = defaultdict(dict)
    for _, r in pure:
        for row in r["rows"]:
            res[row["id"]][r["label"]] = {"v": row["verdict"], "a": row.get("answer")}
    tasks = [
        {
            "id": it["id"],
            "grade": it["grade"],
            "category": it["category"],
            "q": it["q"],
            "gold": it["gold"],
            "src": {k: it["source"].get(k) for k in ("title", "url", "author", "licence", "exercise")},
            "res": res.get(it["id"], {}),
        }
        for it in data["items"]
    ]
    out = {
        "set": data["set"],
        "sha256": hashlib.sha256(SET.read_bytes()).hexdigest(),
        "licence": data["licence"],
        "runs": [run_summary(p, r) for p, r in pure],
        "lm": run_summary(*lm[-1]) if lm else None,
        "lm_note": None if lm else a.lm_note,
        "tasks": tasks,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"→ {OUT.relative_to(ROOT)}: {len(out['runs'])} pomiarów czystej grzybni, LM: {'tak' if lm else 'brak'}, {len(tasks)} zadań")


if __name__ == "__main__":
    main()
