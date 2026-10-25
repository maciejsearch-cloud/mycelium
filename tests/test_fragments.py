"""Strzępki: ekstrakcja z prawdziwych słowników i łączenie warstw (bez sieci)."""

import json
from pathlib import Path

from iot_mycelium.ai import fragments as fr

DATA = Path(__file__).resolve().parents[1] / "web" / "public" / "data"
LEX = json.loads((DATA / "lexicon.json").read_text())
CAP = json.loads((DATA / "captcha.json").read_text())
QA = json.loads((DATA / "qa.json").read_text())


def test_key_matches_sql_normalisation():
    f = fr.Frag(0, "  Warszawa ", "populacja", "1 862  402")
    assert f.key == "0:warszawa|populacja|1 862 402"
    assert fr.Frag(0, "warszawa", "populacja", "1 862 402").key == f.key


def test_lexicon_extraction_is_real_and_complete():
    out = fr.from_lexicon(LEX, 0, 50)
    hier = [f for f in out if f.source == "wordnet" and f.ref == "CILI"]
    assert any(f.subj == "Ssak" and f.obj == "Zwierzę" for f in hier)
    w0, lang0, cats0 = LEX["words"][0]
    names = [c["pl"] for c in LEX["taxonomy"]]
    assert {f.obj for f in out if f.subj == w0} == {names[c] for c in cats0}
    assert all(f.layer == 0 and f.rel == "jest" for f in out)
    # druga paczka nie powtarza hierarchii
    assert not [f for f in fr.from_lexicon(LEX, 50, 10) if f.ref == "CILI"]


def test_consensus_only_confident_answers_become_fragments():
    w = LEX["questions"][0]
    truths = {
        f"{w['id']}c001": ("tak", 0.95),
        f"{w['id']}c002": ("tak", 0.55),
        "k01": ("tak", 0.9),
        "k02": ("nie", 0.3),
    }
    out = fr.from_consensus(truths, QA, LEX)
    names = [c["pl"] for c in LEX["taxonomy"]]
    assert fr.Frag(0, w["word"], "jest", names[1], w["lang"], "consensus").key in {f.key for f in out}
    assert not any(f.ref == f"{w['id']}c002" for f in out)  # niepewne → Weryfikuj, nie strzępek
    assert [f.ref for f in out if f.rel == "prawdziwe"] == ["k01"]


def test_build_layers_thread_to_ball():
    frags = fr.from_lexicon(LEX, 0, 30) + fr.from_pairs(CAP["pairs"][:20])
    g = fr.build(frags, LEX)
    layers = g.layer_counts()
    assert layers[0] >= len({f.key for f in frags}) and layers[1] > 0 and layers[2] > 0
    # nić: strzępek „X jest Ssak” → pojęcie X → pojęcie Ssak / temat Zwierzę
    f = next(f for f in frags if f.obj == "Ssak" and f.ref == "lexicon")
    path = fr.chain(g, f.key)
    assert path[0] == f and path[-1].layer >= 1
    assert any(lk.kind == "is_a" and lk.dst.subj == "Ssak" for lk in g.links.values())
    assert fr.topic("Zwierzę").key in g.frags
    # tłumaczenia łączą pojęcia PL i EN
    p = CAP["pairs"][0]
    assert (fr.concept(p["pl"]).key, fr.concept(p["en"], "en").key, "translation") in g.links


def test_synonyms_from_shared_translation():
    g = fr.build([fr.Frag(0, "auto", "tlumaczenie", "car"), fr.Frag(0, "samochód", "tlumaczenie", "car")])
    assert (fr.concept("auto").key, fr.concept("samochód").key, "synonym") in g.links


def test_conflicts_detect_functional_disagreement():
    a = fr.Frag(0, "Warszawa", "populacja", "1862402", source="wikidata")
    b = fr.Frag(0, "warszawa", "populacja", "3700000", source="chat")
    c = fr.Frag(0, "Warszawa", "jest", "miasto")
    assert fr.conflicts([a, b, c]) == [sorted([a, b], key=lambda f: f.key)]
    assert fr.conflicts([a, c]) == []


def test_batches_respect_rpc_limits():
    g = fr.build(fr.from_lexicon(LEX, 0, 400), LEX)
    bs = list(fr.batches(g))
    assert all(len(f) <= 250 and len(lk) <= 400 for f, lk in bs)
    assert sum(len(f) for f, _ in bs) == len(g.frags)
    assert sum(len(lk) for _, lk in bs) == len(g.links)
