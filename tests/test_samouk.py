"""Samouk: zadania ze sprawdzalną odpowiedzią i wybór typów (ciekawość)."""

from pathlib import Path

from iot_mycelium.mesh import samouk

LEX = Path(__file__).resolve().parents[1] / "web" / "public" / "data" / "rozbior" / "morf-lfg.json.gz"


def test_every_type_generates_unique_checked_items():
    f = samouk.noun_forms(LEX)
    assert len(f) >= 20 and f["brat"]["gen"] == "brata" and f["książka"]["loc"] == "książce"
    for t in samouk.TYPES:
        xs = samouk.generate(t, 30, 11, forms=f)
        assert len(xs) == 30 and len({x.sha for x in xs}) == 30
        assert all(0 <= x.answer < len(x.options) and len(set(x.options)) == len(x.options) for x in xs)


def test_case_and_role_answers_follow_construction():
    f = samouk.noun_forms(LEX)
    for x in samouk.generate("przypadki", 40, 3, forms=f):
        assert x.options[x.answer] == samouk.CASES[x.kind][0]
    for x in samouk.generate("role", 40, 3):
        word = x.options[x.answer]
        assert word.lower() in x.q.lower()


def test_probe_is_held_out_from_training_seeds():
    f = samouk.noun_forms(LEX)
    for t in samouk.TYPES:
        probe = {x.sha for x in samouk.probe(t, f)}
        train = samouk.generate(t, 200, 10_001, exclude=probe, forms=f)
        assert not probe & {x.sha for x in train}


def test_choose_prefers_weak_types_and_explains():
    st = {
        "logika": {"acc": 0.4, "p_right": 0.35, "progress": None, "n": 40},
        "matematyka": {"acc": 0.2, "p_right": 0.3, "progress": 0.08, "n": 40},
        "przypadki": {"acc": 0.97, "p_right": 0.9, "progress": 0.0, "n": 40},
        "role": {"acc": 0.5, "p_right": 0.45, "progress": None, "n": 40},
    }
    out = samouk.choose(st, 9, {"przypadki": 5, "matematyka": 2})
    a = out["alloc"]
    assert sum(a.values()) == 9 and min(a.values()) >= 1
    assert a["matematyka"] >= a["przypadki"] and a["przypadki"] == 1
    assert "trafność 20%" in out["why"]["matematyka"]["reason"]
