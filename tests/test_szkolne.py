"""Testy szkolne: zamrożony zestaw testowy nie może się zmienić, dev i test są rozłączne, ocena działa."""

import hashlib
import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
B = ROOT / "benchmarks/szkolne"
FROZEN_SHA256 = "01f789d134443b124dbb8f8568c846697d753d54fbf7f2ea5764d65974ce36fd"

spec = importlib.util.spec_from_file_location("szkolne_eval", ROOT / "scripts/szkolne_eval.py")
se = importlib.util.module_from_spec(spec)
spec.loader.exec_module(se)


def test_frozen_set_unchanged():
    assert hashlib.sha256((B / "szkolne_v1.json").read_bytes()).hexdigest() == FROZEN_SHA256


def test_dev_and_test_disjoint_by_exercise():
    t = json.loads((B / "szkolne_v1.json").read_text())["items"]
    d = json.loads((B / "szkolne_dev_v1.json").read_text())["items"]

    def ex(it):  # jedno ćwiczenie = wszystkie jego podpunkty (8.1, 8.2, 3a, 3b) w tej samej części
        return it["source"]["zpe_id"], re.sub(r"(\d+)(?:\.\d+|[a-z])(?=\s|$)", r"\1", it["source"]["exercise"])

    assert not {ex(i) for i in t} & {ex(i) for i in d}
    assert not {i["q"] for i in t} & {i["q"] for i in d}
    assert len({i["id"] for i in t + d}) == len(t) + len(d)
    for it in t + d:
        s = it["source"]
        assert s["url"].startswith("https://zpe.gov.pl/") and s["licence"] in ("CC BY 3.0", "CC BY-SA 3.0")
        assert it["grade"] in ("1", "2", "3", "1-3", "4", "5", "6", "7", "4-8")


def test_verdict():
    it = {"category": "zadania_tekstowe", "gold": [["15"]]}
    assert se.verdict(it, "Odpowiedź: 15") == "ok"
    assert se.verdict(it, "15 i jeszcze 3, razem 18") == "zle"
    assert se.verdict(it, None) == "nie_wiem"
    assert se.verdict(it, "Nie wiem.") == "nie_wiem"
    assert se.verdict({"category": "ulamki", "gold": [["0,73"]]}, "0.73") == "ok"
    assert se.verdict({"category": "jednostki", "gold": [["435"]]}, "18 270 : 42 = 435") == "ok"
    assert se.verdict({"category": "arytmetyka", "gold": [["5", "7", "9"]]}, "5, 7 i 9") == "ok"
    assert se.verdict({"category": "ulamki", "gold": [["1/5"], ["0,2"]]}, "to 1/5") == "ok"
    pos = {"category": "czesci_mowy", "gold": [["czasownik"]]}
    assert se.verdict(pos, "„mży” to czasownik") == "ok"
    assert se.verdict(pos, "czasownik albo rzeczownik") == "zle"
    g = {"category": "rodzaj", "gold": [["męski zwierzęcy"]]}
    assert se.verdict(g, "rodzaj męski zwierzęcy") == "ok"
    assert se.verdict(g, "rodzaj męski") == "zle"
    assert se.verdict({"category": "przypadki", "gold": [["sroce"]]}, "sroce") == "ok"


def test_saved_results_match_verdicts():
    """Zapisane pomiary (results/szkolne) i opublikowany widok liczą się z odpowiedzi tą samą oceną – bez ręcznych liczb."""
    items = {
        it["id"]: it
        for s in ("szkolne_v1.json", "szkolne_dev_v1.json")
        for it in json.loads((B / s).read_text())["items"]
    }
    files = sorted((ROOT / "results/szkolne").glob("*.json"))
    assert files
    for p in files:
        rep = json.loads(p.read_text())
        cnt = {"ok": 0, "zle": 0, "nie_wiem": 0}
        for r in rep["rows"]:
            v = se.verdict(items[r["id"]], r.get("answer"))
            assert v == r["verdict"], (p.name, r["id"])
            cnt[v] += 1
        assert (rep["ok"], rep["zle"], rep["nie_wiem"]) == (cnt["ok"], cnt["zle"], cnt["nie_wiem"]), p.name
        assert rep["n"] == len(rep["rows"])
    pub = json.loads((ROOT / "web/public/data/szkolne/wyniki.json").read_text())
    for run in pub["runs"]:
        rep = json.loads((ROOT / run["file"]).read_text())
        assert (run["ok"], run["zle"], run["nie_wiem"]) == (rep["ok"], rep["zle"], rep["nie_wiem"])
    assert [r["when"] for r in pub["runs"]] == sorted(r["when"] for r in pub["runs"])
