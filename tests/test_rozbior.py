"""Rozbiór zdań: analiza reguł (części mowy, części zdania, role), miary, model MYCRB2, pytania, FedAvg i bramka."""

import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from iot_mycelium.rozbior import analiza, miary, model, pytania, zbior

ROOT = Path(__file__).resolve().parents[1]


def T(form, lemma, upos, head, deprel, **feats):
    return {"form": form, "lemma": lemma, "upos": upos, "feats": feats, "head": head, "deprel": deprel}


# „Kuba nie dał wczoraj Ani starej książki w domu.”
KUBA = [
    T("Kuba", "Kuba", "PROPN", 3, "nsubj", Case="Nom", Gender="Masc", Animacy="Hum", Number="Sing"),
    T("nie", "nie", "PART", 3, "advmod:neg", Polarity="Neg"),
    T(
        "dał",
        "dać",
        "VERB",
        0,
        "root",
        Aspect="Perf",
        Tense="Past",
        VerbForm="Fin",
        Mood="Ind",
        Gender="Masc",
        Number="Sing",
    ),
    T("wczoraj", "wczoraj", "ADV", 3, "advmod"),
    T("Ani", "Ania", "PROPN", 3, "iobj", Case="Dat", Gender="Fem", Number="Sing"),
    T("starej", "stary", "ADJ", 7, "amod", Case="Gen", Gender="Fem", Number="Sing", Degree="Pos"),
    T("książki", "książka", "NOUN", 3, "obj", Case="Gen", Gender="Fem", Number="Sing"),
    T("w", "w", "ADP", 9, "case"),
    T("domu", "dom", "NOUN", 3, "obl", Case="Loc", Gender="Masc", Number="Sing"),
    T(".", ".", "PUNCT", 3, "punct"),
]


def test_analiza_parts_and_frame():
    a = analiza.analyse(KUBA)
    parts = {t["form"]: t["part"] for t in a["tokens"]}
    assert parts["Kuba"] == "podmiot" and parts["dał"] == "orzeczenie" and parts["książki"] == "dopełnienie"
    assert parts["starej"] == "przydawka" and a["tokens"][5]["of"] == 7
    assert parts["domu"] == "okolicznik" and a["tokens"][8]["okol"].startswith("miejsca")
    f = a["frames"][0]
    assert f["neg"] and f["aspect"] == "Perf" and f["tense"] == "Past"
    qs = {g["q"] for g in f["args"]}
    assert {"KTO/CO", "KOMU/CZEMU", "GDZIE"} <= qs
    assert a["tokens"][0]["pos"] == "rzeczownik własny"


def test_miary_identity_and_miss():
    m = miary.score([KUBA], [KUBA])
    assert m["role_f1"] == 1.0 and m["upos"] == 1.0 and m["las"] == 1.0
    bad = [dict(t) for t in KUBA]
    bad[4] = {**bad[4], "head": 7, "deprel": "nmod"}  # Ani podpięta pod „książki” – rola KOMU znika
    m2 = miary.score([KUBA], [bad])
    assert 0 < m2["role_f1"] < 1


def test_mst_single_root_and_tree():
    rng = np.random.default_rng(0)
    for n in range(2, 12):
        S = rng.normal(size=(n + 1, n + 1))
        h = model.mst(S)
        assert len(h) == n + 1 and sum(1 for x in h[1:] if x == 0) == 1
        for i in range(1, n + 1):  # brak cykli: od każdego węzła dojdziemy do korzenia
            seen, j = set(), i
            while j != 0:
                assert j not in seen
                seen.add(j)
                j = h[j]


def _tiny():
    words, chars = ["kuba", "dał"], list("abcdeghiklnorstuwyzłąę")
    H = {
        "words": words,
        "chars": chars,
        "upos": ["NOUN", "VERB", "PUNCT"],
        "feats": {k: ["_", "x"] for k in analiza.FEATS},
        "lemmas": ["", "*"],
        "deprels": ["root", "nsubj", "punct"],
    }
    rng = np.random.default_rng(1)
    W = {k: rng.normal(scale=0.1, size=s).astype(np.float32) for k, s in model.shapes(H)}
    return H, W


def test_model_roundtrip_and_predict():
    H, W = _tiny()
    body = model.save("", H, W)
    H2, W2 = model.load(body)
    assert H2["words"] == H["words"]
    for k in W:
        assert np.allclose(W[k], W2[k], atol=2e-3)
    toks = model.predict(H2, W2, ["Kuba", "dał", "."], "pdb")
    assert len(toks) == 3 and sum(t["head"] == 0 for t in toks) == 1
    assert all(0 <= t["p"] <= 1 for t in toks)
    # wymuszenie etykiety (redecode): pusty force/unk = ten sam wynik; silny prior łuku i etykiety jest respektowany
    assert model.predict(H2, W2, ["Kuba", "dał", "."], "pdb", force={}, unk=frozenset()) == toks
    pr = np.full(len(H2["deprels"]), -50.0, np.float32)
    pr[H2["deprels"].index("nsubj")] = 0.0
    hb = np.array([0.0, 0.0, 50.0, 0.0], np.float32)  # nadrzędnik „dał”
    t2 = model.predict(H2, W2, ["Kuba", "dał", "."], "pdb", force={0: (pr, hb)}, unk=frozenset({0}))
    if t2[0]["head"] != 0:
        assert t2[0]["head"] == 2 and t2[0]["deprel"] == "nsubj"


def test_pytania_role_and_negation():
    items = pytania.questions(KUBA, text="Kuba nie dał wczoraj Ani starej książki w domu.")
    assert any(i["question"].startswith("Komu") and i["answer"] == "Ani" for i in items)
    # dopełniacz przeczenia („nie dał książki”) – bez „nie” zdanie byłoby niegramatyczne, więc brak pytania tak/nie
    assert not any(i["kind"] == "przeczenie" for i in items)
    spi = [
        KUBA[0],
        KUBA[1],
        T("śpi", "spać", "VERB", 0, "root", Aspect="Imp", Tense="Pres", VerbForm="Fin"),
        KUBA[7],
        KUBA[8],
        KUBA[9],
    ]
    spi = [{**t, "head": {3: 3, 9: 5}.get(t["head"], t["head"])} for t in spi]
    spi[2]["head"] = 0
    yn = [i for i in pytania.questions(spi, text="Kuba nie śpi w domu.") if i["kind"] == "przeczenie"]
    assert yn and yn[0]["answer"] == "nie" and yn[0]["question"] == "Czy Kuba śpi w domu?"
    assert not any(i["question"].endswith("??") for i in items)
    # pytania tylko ze zdań oznajmujących
    assert pytania.questions([*KUBA[:-1], T("?", "?", "PUNCT", 3, "punct")]) == []


def test_pytania_check_with_selfplay():
    from iot_mycelium.mesh import selfplay

    tasks = pytania.to_tasks(pytania.questions(KUBA, text="Kuba nie dał."), "Kuba nie dał.")
    t = next(x for x in tasks if x.kind == "rozbiór: rola" and x.answer == "Ani")
    assert selfplay.check(t, "Ani") and not selfplay.check(t, "Kuba")


def test_gate_sha_depends_on_rules():
    meta = {"eval_sha": "a" * 64}
    assert zbior.gate_sha(meta, b"x") != zbior.gate_sha(meta, b"y")


@pytest.mark.skipif(not (zbior.DATA / "meta.json").exists(), reason="brak eksportu UD")
def test_parity_fixture_current():
    """Plik zgodności TS↔Python odpowiada bieżącym regułom (zmiana reguł = nowy odcisk bramki)."""
    r = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "rozbior_parity_fixture.py"), "--check"], capture_output=True, text=True
    )
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.mark.skipif(not (zbior.DATA / "meta.json").exists(), reason="brak eksportu UD")
def test_dataset_splits_disjoint():
    meta = __import__("json").loads((zbior.DATA / "meta.json").read_text())
    assert all(n.startswith("test-") for n in meta["eval_files"])
    assert not any(n.startswith("test-") for n in meta["files"] if n.startswith("train-"))
    test = {s["text"] for s in zbior.local("test-pdb")}
    train = {s["text"] for s in zbior.local("train-pdb-00")}
    assert len(test & train) < 0.01 * len(test)  # w UD zdarzają się identyczne krótkie zdania


def test_morf_lexicon_and_parity():
    """Warstwa Morfeusza (leksykon przeglądarki): lemat z SGJP i zgodność z odciskami (te same co test TS)."""
    import gzip
    import json

    from iot_mycelium.rozbior import morf, zbior

    lex = json.loads(gzip.decompress((zbior.DATA / "morf.json.gz").read_bytes()))
    assert lex["meta"]["license"] == "BSD-2-Clause"
    assert ("szkoła", "subst:sg:loc:f") in morf.lex_analyses(lex, "szkole")
    fx = json.loads((zbior.DATA / "morf-parity.json").read_text())
    H = fx["head"]
    for s in fx["sents"][:20]:
        up = [t["lp"]["upos"] for t in s["toks"]]
        fe = {k: [t["lp"]["feats"][k] for t in s["toks"]] for k in H["feats"]}
        import numpy as np

        got = morf.select(
            H,
            s["toks"],
            np.array(up),
            {k: np.array(v) for k, v in fe.items()},
            lex,
            "pdb",
            lex["meta"]["alpha"],
            lex=lex,
        )
        assert [(t.get("lemma"), t["upos"], t.get("feats")) for t in got] == [
            (w["lemma"], w["upos"], w["feats"]) for w in s["want"]
        ]


def test_glosy_guard_and_masks():
    from iot_mycelium.rozbior import glosy

    held = [
        {
            "toks": [
                {"form": w}
                for w in ["Ala", "ma", "kota", "i", "dwa", "psy", ",", "a", "także", "chomika", "w", "klatce", "."]
            ]
        }
    ]
    g = glosy.Guard(held)
    assert g.leaks("Ala ma kota, i dwa psy.") is False  # za krótkie na 8-gram, inny tekst
    assert g.leaks("ala ma kota i dwa psy, a także chomika w klatce!")  # ta sama treść po normalizacji
    assert g.leaks("Wczoraj: Ala ma kota i dwa psy, a także chomika")  # wspólny 8-gram
    toks = [
        {"form": "Kuba", "lemma": "Kuba", "upos": "PROPN", "head": "2", "deprel": "nsubj", "part": "podmiot"},
        {"form": "dał", "lemma": "dać", "upos": "VERB", "head": "0", "deprel": "root", "part": "orzeczenie"},
        {"form": "Ani", "lemma": "Ania", "upos": "PROPN", "head": "2", "deprel": "obl", "part": "okolicznik"},
        {"form": "książkę", "lemma": "książka", "upos": "NOUN", "head": "2", "deprel": "obj", "part": "dopełnienie"},
    ]
    rows = [
        {"id": 1, "sentence": "Kuba dał Ani książkę", "status": "confirmed", "toks": toks},
        {"id": 2, "sentence": "Kuba dał Ani książkę.", "status": "corrected", "toks": toks},  # duplikat po normalizacji
        {"id": 3, "sentence": "Ala ma kota i dwa psy, a także chomika w klatce", "status": "confirmed", "toks": toks},
        {
            "id": 4,
            "sentence": "Kuba dał Ani nową książkę",
            "status": "corrected",
            "toks": toks,
            "correction": [{"i": 3, "part": "dopełnienie"}, {"i": 4, "upos": "NOUN"}],
        },
        {"id": 5, "sentence": "zła", "status": "wrong", "toks": toks},
    ]
    sents, st = glosy.build(rows, g)
    assert st == {"rows": 5, "leak": 1, "invalid": 1, "used": 2}
    s1, s4 = sents
    assert all(
        t["lemma"] is None and t["feats"] is None and t["upos"] is None for t in s1["toks"]
    )  # lematy/cechy nigdy z głosów
    assert [t["head"] for t in s1["toks"]] == [2, 0, 2, 2] and s1["toks"][2]["deprel"] == "obl"
    assert s4["toks"][2]["deprel"] == "obj" and s4["toks"][3]["upos"] == "NOUN"


def test_logika_helpers():
    from iot_mycelium.rozbior import logika

    assert logika.sentences("Czy zdania „A jest. B” i „C” mogą być? Odpowiedz: tak, nie albo nie wiadomo.") == [
        "Czy zdania „A jest. B” i „C” mogą być?"
    ]
    assert logika.stem("róża") == logika.stem("róż") and logika.stem("karpie") == logika.stem("karpi")
    a, b = logika.Lit(frozenset({"x"}), True), logika.Lit(frozenset({"y"}), True)
    assert logika.closure({b.neg()}, [(a, b)]) >= {a.neg()}  # modus tollens
    assert logika.SQUARE[("notall", "all")] == "nie" and logika.SQUARE[("some", "all")] == "nie wiadomo"


def test_morf_agrees_and_proper_only():
    from iot_mycelium.rozbior import morf

    # szum mapy tag→UD: „subst:sg:dat:f” nie może dać mianownika ani rzeczownika bez przypadku
    assert morf.agrees("subst:sg:dat:f", "PROPN", {"Case": "Dat", "Number": "Sing", "Gender": "Fem"})
    assert not morf.agrees("subst:sg:dat:f", "PROPN", {"Case": "Nom", "Number": "Sing", "Gender": "Fem"})
    assert not morf.agrees("subst:sg:dat:f", "NOUN", {})
    assert morf.agrees("subst:pl:nom:n:pt", "NOUN", {"Case": "Nom", "Number": "Ptan"})  # „drzwi”
    assert morf.agrees("prep:gen", "ADP", {})  # przyimek w UD bez przypadku
    assert morf.agrees("subst:sg:nom:n:ncol", "AUX", {})  # „em” – w UD aglutynant (AUX)
    an = [("Ania", "subst:sg:dat:f"), ("ani", "conj")]
    assert morf.proper_only(an, "Ani", "dał", "CCONJ") == [("Ania", "subst:sg:dat:f")]
    assert morf.proper_only(an, "Ani", None, "CCONJ") == an  # początek zdania: wielka litera nic nie mówi
    assert morf.proper_only(an, "Ani", "dał", "NOUN") == an  # model nie myli z funkcyjnym → bez zmian


def test_morf_licensed_walenty():
    from iot_mycelium.rozbior import morf

    val = {"dać": {"s": [["KTO/CO", "KOMU/CZEMU", "KOGO/CO"]]}}
    assert morf.licensed(val, "dać", False) == {"Nom", "Dat", "Acc"}
    assert "Gen" in morf.licensed(val, "dać", True)  # „nie dał książki”
    assert morf.licensed(val, "nieznany", False) == set()
