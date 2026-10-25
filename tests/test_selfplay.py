from iot_mycelium.mesh import selfplay as sp


def test_generate_unique_deterministic_all_categories():
    a = sp.generate(400, seed=1)
    assert len({t.sha for t in a}) == 400
    assert [t.question for t in a] == [t.question for t in sp.generate(400, seed=1)]
    assert {t.kind for t in a} == set(sp.CATEGORIES)


def test_excludes_gate_hashes_and_ngrams():
    a = sp.generate(200, seed=1)
    ex = {a[0].sha, a[1].sha}
    assert not ex & {t.sha for t in sp.generate(200, seed=1, exclude=ex)}
    gate = sp.ngrams(a[5].question, 8)
    for t in sp.generate(200, seed=3, gate_ngrams=gate):
        assert not sp.ngrams(t.question, 8) & gate


def test_check_correct_and_wrong():
    for t in sp.generate(600, seed=2):
        assert sp.check(t, f"Odpowiedź: {t.answer}."), t
        if t.answer.lstrip("-").isdigit():
            wrong = str(int(t.answer) + 1)
        elif t.options:
            wrong = next(o for o in t.options if o != t.answer)
        elif t.answer in ("tak", "nie", "nie wiadomo"):
            wrong = {"tak": "nie", "nie": "nie wiadomo", "nie wiadomo": "tak"}[t.answer]
        else:
            wrong = next(n for n in sp.NAMES if n != t.answer)
        assert not sp.check(t, wrong), t


def test_agreement_inflected_forms():
    t = sp.Task("odmiana", "Bartkowi dała Ala list. Komu dano?", "Bartek")
    assert sp.check(t, "Bartkowi.") and not sp.check(t, "Ala")


def test_tally():
    ty = sp.Tally()
    ty.add("warunki", True)
    ty.add("warunki", False)
    assert ty.summary() == {"warunki": {"n": 2, "correct": 1, "acc": 0.5}}
    tb = sp.Tally()
    for ok, ans in [(True, "tak"), (False, "tak"), (True, "nie"), (False, "tak")]:
        tb.add("warunki", ok, ans, 2)
    assert tb.summary()["warunki"] == {"n": 4, "correct": 2, "acc": 0.5, "baseline": 0.75, "baseline_answer": "tak"}
    assert tb.per_level() == {"warunki": {"2": {"n": 4, "correct": 2, "acc": 0.5}}}


def test_ternary_balanced_and_levels():
    import collections

    ts = sp.generate(900, seed=5)
    c = collections.Counter((t.kind, t.answer) for t in ts if t.kind in sp.TERNARY)
    for k, opts in sp.TERNARY.items():
        n = [c[(k, a)] for a in opts]
        assert min(n) > 0 and max(n) - min(n) <= 1, (k, n)
    hard = sp.generate(200, seed=5, levels={k: 3 for k in sp.CATEGORIES})
    for t in hard:
        assert t.level == sp.MAX_LEVEL.get(t.kind, 1), t
        assert sp.check(t, t.answer)


def test_new_categories_answers_are_correct():
    assert sp.numeral_form(2, "kot") == "koty" and sp.numeral_form(5, "kot") == "kotów"
    assert (
        sp.numeral_form(12, "kot") == "kotów"
        and sp.numeral_form(22, "kot") == "koty"
        and sp.numeral_form(21, "kot") == "kotów"
    )
    assert sp.numeral_form(104, "książka") == "książki" and sp.numeral_form(112, "książka") == "książek"
    import random

    for s in range(50):
        t = sp.make("ciąg", random.Random(s), 3)
        xs = [int(x) for x in t.question.split(":")[1].split("?")[0].replace(" ", "").strip(",").split(",")]
        d = [b - a for a, b in zip(xs, xs[1:], strict=False)]
        assert int(t.answer) - xs[-1] == d[-1] + (d[-1] - d[-2])
        o = sp.make("kolejność w czasie", random.Random(s), 2)
        assert o.answer in o.question
        a = sp.make("analogia", random.Random(s), 3)
        assert a.answer in a.options and len(set(a.options)) == len(a.options)


def test_target_levels_curriculum():
    pl = {"analogia": {"1": {"n": 20, "acc": 0.9}}, "ciąg": {"2": {"n": 20, "acc": 0.5}}, "łańcuch": {"2": {"n": 20, "acc": 0.1}},
          "warunki": {"1": {"n": 3, "acc": 0.0}}}  # fmt: skip
    r = sp.target_levels(pl)
    assert r["levels"]["analogia"] == 2 and r["levels"]["ciąg"] == 2 and r["levels"]["łańcuch"] == 1
    assert r["levels"]["warunki"] == 1  # za mało prób → bez zmian
    assert r["weights"]["ciąg"] == 2.0 and r["weights"]["analogia"] == 1.0


def test_human_items_need_people():
    hs = sp.human_items(40, seed=1)
    assert len({h.sha for h in hs}) == len(hs) >= 20
    assert {h.kind for h in hs} == {"analogia na wyczucie", "zdrowy rozsądek", "parafraza", "naturalność"}
    for h in hs:
        assert h.why and len(h.options) >= 3 and sp.YN not in h.question


def test_check_strict_against_echo():
    t = sp.Task("sylogizm", "Czy Bartek hoduje kwiaty?" + sp.YN, "tak")
    assert not sp.check(t, "Tak, nie albo nie wiadomo.")
    assert sp.check(t, "Tak, hoduje.")
    n = sp.Task("odmiana", "Adam dał Jankowi list. Kto dał? Podaj imię.", "Adam")
    assert not sp.check(n, "Adam dał Jankowi list.") and sp.check(n, "Adam")
    w = sp.Task("zadanie tekstowe", "15 i 27?", "42")
    assert sp.check(w, "15 + 27 = 42") and not sp.check(w, "42, a może 43")
    u = sp.Task("warunki", "x", "nie wiadomo")
    assert sp.check(u, "Nie da się tego stwierdzić.") and not sp.check(u, "Nie.")
