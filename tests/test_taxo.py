"""Taksonomia słów: prawdziwe dane ze słowników, ocena odtwarzalna z samego przypisania, poprawki właściciela."""

import json
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")
from iot_mycelium.mesh import taxo  # noqa: E402

D = Path(__file__).resolve().parents[1] / "web" / "public" / "data" / "taxo"


@pytest.fixture(scope="module")
def inp():
    return taxo.Inputs(json.loads((D / "inputs.json").read_text()), (D / "emb.bin").read_bytes())


@pytest.fixture(scope="module")
def built(inp):
    return taxo.build(inp, taxo.PARAMS[2])


def test_eval_fingerprint_matches_meta():
    meta = json.loads((D / "meta.json").read_text())
    assert taxo.eval_sha(json.loads((D / "inputs.json").read_text())) == meta["eval_sha"]
    assert meta["eval_n"] == 2174


def test_hierarchy_and_metrics(inp, built):
    res, m = built
    nodes = res["nodes"]
    assert all(lf >= 0 and nodes[lf].get("leaf") for lf in res["leaf"])
    assert {nd["lvl"] for nd in nodes} >= {0, 1, 2}
    assert m["acc"] > 0.5 and m["nmi_cat"] > 0.3  # z hiperonimami wyraźnie lepiej niż losowo (1/31)
    # weryfikator przelicza metryki z samego przypisania (po serializacji) – dokładnie te same liczby
    again = taxo.metrics(json.loads(taxo.result_bytes(res, {})), inp.gold, inp.eval)
    assert again == m


def test_build_is_deterministic(inp, built):
    res, _ = taxo.build(inp, taxo.PARAMS[2])
    assert res["leaf"] == built[0]["leaf"]


def test_owner_corrections(inp, built):
    res, _ = built
    vers = {0: res}
    nodes = res["nodes"]
    cat = next(nd for nd in nodes if nd["lvl"] == 1 and nd["n"] > 200)
    other = next(nd for nd in nodes if nd["lvl"] == 1 and nd["p"] == cat["p"] and nd["id"] != cat["id"])
    w = next(i for i, lf in enumerate(res["leaf"]) if i not in inp.eval and taxo.ancestors(nodes, lf)[1] == other["id"])
    labels = [
        {"item_type": "category", "item_ref": f"tw:{w}", "verdict": "correct", "truth": f"c:0:{cat['id']}"},
        {"item_type": "category", "item_ref": f"tc:0:{cat['id']}", "verdict": "correct", "truth": "name:Moja nazwa"},
        {"item_type": "category", "item_ref": "tc:0:999999", "verdict": "reject", "truth": None},
    ]
    assert taxo.corr_needs(labels) == [0]
    corr = taxo.corrections(labels, vers)
    assert w in corr["pins"] and len(corr["names"]) == 1
    r2, _ = taxo.build(inp, taxo.PARAMS[2], corr)
    n2 = r2["nodes"]
    named = [nd for nd in n2 if nd.get("owner_name")]
    assert named and named[0]["name_pl"] == "Moja nazwa"
    assert named[0]["id"] in taxo.ancestors(n2, r2["leaf"][w])


def test_word_corrections_trust_own_category_and_notword(inp, built):
    res, _ = built
    vers = {0: res}
    nodes = res["nodes"]
    free = [i for i in range(inp.n) if i not in inp.eval]
    w1, w2, w3, w4 = free[:4]
    cat = next(nd for nd in nodes if nd["lvl"] == 1)
    gid = inp.tax[inp.gold[w1]]["id"]
    c = f"c:0:{cat['id']}"
    labels = [
        # zaufana osoba (waga 0,5) – za mało sama; dwie razem wystarczą
        {
            "item_type": "category",
            "item_ref": f"tw:{w1}",
            "verdict": "correct",
            "truth": f"g:{gid}",
            "reviewer": "contrib",
            "weight": 0.5,
        },
        {
            "item_type": "category",
            "item_ref": f"tw:{w2}",
            "verdict": "correct",
            "truth": c,
            "reviewer": "contrib",
            "weight": 0.5,
        },
        {
            "item_type": "category",
            "item_ref": f"tw:{w2}",
            "verdict": "correct",
            "truth": c,
            "reviewer": "contrib",
            "weight": 0.6,
        },
        # właściciel: własna kategoria z rodzicem i drugie słowo w tej samej kategorii
        {
            "item_type": "category",
            "item_ref": f"tw:{w3}",
            "verdict": "correct",
            "truth": f"own:Moje owady|{c}",
            "reviewer": "owner",
            "weight": 1,
        },
        {
            "item_type": "category",
            "item_ref": f"tw:{w4}",
            "verdict": "correct",
            "truth": "own:moje owady|",
            "reviewer": "owner",
            "weight": 1,
        },
        {
            "item_type": "category",
            "item_ref": f"tw:{w1}",
            "verdict": "reject",
            "truth": "notword",
            "reviewer": "owner",
            "weight": 1,
        },
    ]
    assert taxo.corr_needs(labels) == [0]
    corr = taxo.corrections(labels, vers, inp)
    assert w1 not in corr["pins"]  # 0,5 < 1 → bez zmiany
    assert w2 in corr["pins"]  # 0,5 + 0,6 ≥ 1
    assert corr["own"] == {w3: "Moje owady", w4: "moje owady"}
    assert w4 in corr["pins"][w3] and w3 in corr["pins"][w4]
    assert corr["bad"] == [w1]
    r2, m2 = taxo.build(inp, taxo.PARAMS[2], corr)
    assert r2["own"] == {str(w3): "Moje owady", str(w4): "moje owady"} and r2["bad"] == [w1]
    assert all(w1 not in nd["top"] for nd in r2["nodes"])
    assert taxo.metrics(json.loads(taxo.result_bytes(r2, {})), inp.gold, inp.eval) == m2


def test_hypernym_and_wordnet_targets(inp, built):
    res, _ = built
    w = next(i for i in range(inp.n) if i not in inp.eval and inp.rows[i])
    h = inp.rows[w][0]
    labels = [{"item_type": "category", "item_ref": f"tw:{w}", "verdict": "correct", "truth": f"h:{h}"}]
    corr = taxo.corrections(labels, {0: res}, inp)
    assert corr["pins"][w] == {i for i, r in enumerate(inp.rows) if h in r}


def test_names_prefer_polish_and_readable_fallback(built):
    res, _ = built
    for nd in res["nodes"]:
        assert not nd["name_pl"].startswith("~")
        if nd["src"] == "medoid":
            assert nd["name_pl"].startswith("≈ ")


def test_seed_tree_names_and_honest_eval(inp):
    """Drzewo seed: każda kategoria ma polską nazwę i źródło; zbiór oceny nie dostaje kategorii seed wprost."""
    seed = json.loads((D / "seed.json").read_text())
    meta = json.loads((D / "meta.json").read_text())
    import hashlib

    assert meta["files"]["seed.json"] == hashlib.sha256((D / "seed.json").read_bytes()).hexdigest()
    assert all(c["pl"] and c["label_src"] in ("wikidata+wordnet", "plwordnet", "korekta") for c in seed["cats"])
    assert max(c["lvl"] for c in seed["cats"]) <= 4  # najwyżej 5 poziomów
    assert all(c["parent"] < c["id"] for c in seed["cats"])  # rodzice przed dziećmi
    si = taxo.Inputs(inp.raw, (D / "emb.bin").read_bytes(), seed)
    res, m = taxo.build(si, taxo.SEED_PARAMS[0])
    nodes = res["nodes"]
    # nazwy widoczne tylko z seed (albo od człowieka); grupy automatyczne są oznaczone jako wewnętrzne
    assert {nd["src"] for nd in nodes} <= {"seed", "auto", "owner"}
    assert all(nd["name_pl"] == seed["cats"][nd["seed"]]["pl"] for nd in nodes if nd["src"] == "seed")
    assert m["acc"] > 0.6 and m["named_seed"] > 0.3
    # ceik (rusałka) – motyl → owady
    w = [x[0] for x in inp.words].index("ceik")
    path = [nodes[x]["name_pl"] for x in taxo.ancestors(nodes, res["leaf"][w]) if nodes[x]["src"] == "seed"]
    assert path[-1] == "owady"
    # metryki odtwarzalne z samego przypisania
    assert taxo.metrics(json.loads(taxo.result_bytes(res, {})), inp.gold, inp.eval) == m
    # zbiór oceny nie zależy od mapy seed: zmiana kategorii seed słowa z oceny nic nie zmienia
    ev = sorted(inp.eval)[0]
    seed2 = {**seed, "map": list(seed["map"])}
    seed2["map"][ev] = (seed["map"][ev] + 1) % len(seed["cats"])
    res2, _ = taxo.build(taxo.Inputs(inp.raw, (D / "emb.bin").read_bytes(), seed2), taxo.SEED_PARAMS[0])
    assert res2["leaf"] == res["leaf"]


def test_seed_pick_correction():
    labels = [{"item_type": "category", "item_ref": "tw:5", "verdict": "correct", "truth": "s:3", "reviewer": "owner"}]
    assert taxo.corrections(labels, {})["seed_pick"] == {5: 3}
