"""Testy szkolne (klasy 1–7, zadania z zpe.gov.pl) – pomiar czystej grzybni i LM grzybni w przeglądarce.

Zestawy: benchmarks/szkolne/szkolne_v1.json (zamrożony test) i szkolne_dev_v1.json (dev – tylko na nim stroimy reguły).

  python3 scripts/szkolne_eval.py --model /ścieżka/v3.bin [--set dev]             # kod TS bez przeglądarki (czysta-eval.mjs)
  python3 scripts/szkolne_eval.py --model … --url https://…/demo/mycelium/ --label przed   # zakładka „Czysta grzybnia” na stronie
  python3 scripts/szkolne_eval.py --lm --url https://…/demo/mycelium/ --label przed        # czat z LM grzybni w tej przeglądarce

Ocena (verdict): „nie wiem” = brak odpowiedzi (czysta: źródło „brak”; LM: pusta albo „nie wiem/nie potrafię”), osobno od
błędnych. Liczba: ostatnia liczba w odpowiedzi = złota (przecinek = kropka, „18 270” = 18270); przy kilku liczbach (&)
wszystkie muszą wystąpić. Słowo/etykieta: całe słowo w odpowiedzi; w zamkniętych klasach (część mowy, rodzaj, liczba)
wymienienie także innej etykiety tej klasy = błąd (bez zgadywania „na kilka”).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETS = {"test": ROOT / "benchmarks/szkolne/szkolne_v1.json", "dev": ROOT / "benchmarks/szkolne/szkolne_dev_v1.json"}
NUM = re.compile(r"-?\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?(?:/\d+)?")
CLASSES = {
    "czesci_mowy": [
        "rzeczownik",
        "czasownik",
        "przymiotnik",
        "przysłówek",
        "liczebnik",
        "zaimek",
        "przyimek",
        "spójnik",
        "partykuła",
        "wykrzyknik",
    ],
    "rodzaj": [
        "męski osobowy",
        "męskoosobowy",
        "męski zwierzęcy",
        "męski rzeczowy",
        "żeński",
        "nijaki",
        "niemęskoosobowy",
        "męski",
    ],
    "liczba": ["pojedyncza", "mnoga"],
}
ABSTAIN = re.compile(r"^\s*$|\bnie wiem\b|\bnie potrafię\b|\bnie umiem\b|\bnie znam\b", re.I)


def num(s: str) -> float | None:
    s = s.replace(" ", "").replace(" ", "").replace(",", ".")
    try:
        if "/" in s:
            a, b = s.split("/")
            return round(float(a) / float(b), 9)
        return round(float(s), 9)
    except (ValueError, ZeroDivisionError):
        return None


def low(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower()).strip()


def has_phrase(ans: str, p: str) -> bool:
    return re.search(rf"(?<![\wąćęłńóśźż]){re.escape(low(p))}(?![\wąćęłńóśźż])", low(ans)) is not None


def verdict(item: dict, answer: str | None) -> str:
    """'ok' | 'zle' | 'nie_wiem'"""
    if answer is None or ABSTAIN.search(answer):
        return "nie_wiem"
    nums = [x for x in (num(m) for m in NUM.findall(answer)) if x is not None]
    labels = CLASSES.get(item["category"])
    for alt in item["gold"]:
        if all(num(t) is not None and re.fullmatch(NUM, t) for t in alt):
            want = [num(t) for t in alt]
            if (len(want) == 1 and nums and nums[-1] == want[0]) or (len(want) > 1 and all(w in nums for w in want)):
                return "ok"
            continue
        if all(
            has_phrase(answer, t)
            or (re.match(r"-?\d", t) and has_phrase(answer.replace(".", ","), t.replace(".", ",")))
            for t in alt
        ):
            if labels:
                g = {low(t) for a in item["gold"] for t in a}
                txt = low(answer)
                for t in g:
                    txt = re.sub(rf"(?<![\wąćęłńóśźż]){re.escape(t)}(?![\wąćęłńóśźż])", " ", txt)
                if any(has_phrase(txt, lab) for lab in labels):
                    return "zle"
            return "ok"
    return "zle"


def score(items: list[dict], results: list[dict]) -> dict:
    by = {r["id"]: r for r in results}
    tot = {"n": 0, "ok": 0, "zle": 0, "nie_wiem": 0}
    grade = defaultdict(lambda: dict.fromkeys(tot, 0))
    cell = defaultdict(lambda: dict.fromkeys(tot, 0))
    rows = []
    for it in items:
        r = by[it["id"]]
        v = verdict(it, r.get("answer"))
        for d in (tot, grade[it["grade"]], cell[f"{it['grade']}|{it['category']}"]):
            d["n"] += 1
            d[v] += 1
        rows.append(
            {
                "id": it["id"],
                "grade": it["grade"],
                "category": it["category"],
                "q": it["q"],
                "gold": it["gold"],
                "answer": r.get("answer"),
                "verdict": v,
                "source": r.get("source"),
                "trace": r.get("trace"),
                "local": r.get("local"),
            }
        )
    return {
        **tot,
        "per_grade": dict(sorted(grade.items())),
        "per_grade_category": dict(sorted(cell.items())),
        "rows": rows,
    }


def run_pw(spec: str, env: dict) -> None:
    subprocess.run(
        ["npx", "playwright", "test", "-c", "playwright.eval.config.ts", spec],
        cwd=ROOT / "web",
        env={**os.environ, **env},
        check=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", choices=SETS, default="test")
    ap.add_argument("--model", help="wagi rozbioru (czysta grzybnia)")
    ap.add_argument("--url", help="adres strony: pomiar w prawdziwej przeglądarce")
    ap.add_argument("--lm", action="store_true", help="czat z LM grzybni w przeglądarce zamiast czystej grzybni")
    ap.add_argument("--label", default="pomiar")
    ap.add_argument("--out")
    a = ap.parse_args()
    data = json.loads(SETS[a.set].read_text())
    items = data["items"]
    tmp = Path(tempfile.mkdtemp(prefix="szkolne-"))
    q = [{"id": it["id"], "q": it["q"]} for it in items]
    (tmp / "in.json").write_text(json.dumps({"model": a.model, "items": q}, ensure_ascii=False))
    if a.lm:
        if not a.url:
            ap.error("--lm wymaga --url")
        run_pw(
            "szkolne-lm",
            {
                "EVAL_URL": a.url,
                "SZK_ITEMS": str(tmp / "in.json"),
                "SZK_OUT": str(tmp / "out.json"),
                "EVAL_ROOM": os.environ.get("EVAL_ROOM", "eval-szkolne"),
            },
        )
        mode = "lm_browser"
    elif a.url:
        run_pw("czysta", {"EVAL_URL": a.url, "CZYSTA_ITEMS": str(tmp / "in.json"), "CZYSTA_OUT": str(tmp / "out.json")})
        mode = "czysta_browser"
    else:
        if not a.model:
            ap.error("bez --url potrzebny --model")
        subprocess.run(
            ["node", "scripts/czysta-eval.mjs", str(tmp / "in.json"), str(tmp / "out.json")],
            cwd=ROOT / "web",
            check=True,
            stdout=subprocess.DEVNULL,
        )
        mode = "czysta_node"
    raw = json.loads((tmp / "out.json").read_text())
    res = raw["results"]
    for r in res:
        if mode == "czysta_node" and r.get("source") == "brak":
            r["answer"] = None
    rep = {
        "when": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "set": data["set"],
        "mode": mode,
        "label": a.label,
        "url": a.url,
        "model": raw.get("model"),
        "meta": raw.get("meta"),
        **score(items, res),
    }
    out = (
        Path(a.out)
        if a.out
        else ROOT
        / f"results/szkolne/{rep['when'][:16].replace(':', '').replace('T', '-')}-{data['set']}-{mode}-{a.label}.json"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rep, ensure_ascii=False, indent=1))
    print(f"{mode} {data['set']}: {rep['ok']}/{rep['n']} dobrze, {rep['zle']} źle, {rep['nie_wiem']} „nie wiem”")
    for g, v in rep["per_grade"].items():
        print(f"  klasa {g}: {v['ok']}/{v['n']} (źle {v['zle']}, nie wiem {v['nie_wiem']})")
    print("→", out)


if __name__ == "__main__":
    main()
