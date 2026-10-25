import random

from iot_mycelium.ai.consensus import Answer, infer

YN = ["tak", "nie"]


def _crowd(seed=0, n_q=40, honest=4, liars=2, spammers=3):
    rng = random.Random(seed)
    truth = {f"k{i:02d}": rng.choice(YN) for i in range(n_q)}
    answers = []
    for q, t in truth.items():
        other = "nie" if t == "tak" else "tak"
        for h in range(honest):
            answers.append(Answer(q, f"h{h}", t if rng.random() < 0.85 else other))
        for li in range(liars):
            answers.append(Answer(q, f"l{li}", other))
        for s in range(spammers):
            answers.append(Answer(q, f"s{s}", rng.choice(YN)))
    return truth, answers


def test_recovers_truth_despite_liars_and_spam():
    truth, answers = _crowd()
    c = infer(answers, dict.fromkeys(truth, YN))
    correct = sum(c.truth(q)[0] == t for q, t in truth.items())
    assert correct / len(truth) >= 0.95
    assert min(c.trust[f"h{i}"] for i in range(4)) > 0.7
    assert max(c.trust[f"l{i}"] for i in range(2)) < 0.2  # kłamcy rozpoznani
    assert all(0.3 < c.trust[f"s{i}"] < 0.75 for i in range(3))  # losowi ~ 0.5


def test_liar_majority_needs_gold():
    # 3 kłamców vs 2 uczciwych: bez gold większość wygrywa, z gold – prawda.
    truth = {f"q{i}": "tak" for i in range(10)}
    ans = [Answer(q, f"l{j}", "nie") for q in truth for j in range(3)] + [
        Answer(q, f"h{j}", "tak") for q in truth for j in range(2)
    ]
    opts = dict.fromkeys(truth, YN)
    assert infer(ans, opts).truth("q0")[0] == "nie"
    gold = {"l0": (5, 0), "l1": (5, 0), "l2": (5, 0), "h0": (5, 5), "h1": (5, 5)}
    c = infer(ans, opts, gold)
    assert c.truth("q0")[0] == "tak" and c.truth("q0")[1] > 0.9
    assert c.trust["h0"] > c.trust["l0"]


def test_multiclass_and_invalid_answers_ignored():
    opts = {"i0": ["weather", "alarm", "timer"]}
    ans = [
        Answer("i0", "a", "alarm"),
        Answer("i0", "b", "alarm"),
        Answer("i0", "c", "timer"),
        Answer("i0", "d", "DROP TABLE"),
    ]
    c = infer(ans, opts)
    assert c.truth("i0")[0] == "alarm"
    assert "d" not in c.trust
    assert abs(sum(c.posterior["i0"].values()) - 1) < 1e-9


def test_shared_fixture_matches_browser():
    # Ten sam przykład sprawdza web/e2e (consensus.ts) – wartości referencyjne.
    ans = [
        Answer("k01", "a", "tak"),
        Answer("k01", "b", "tak"),
        Answer("k01", "c", "nie"),
        Answer("k02", "a", "nie"),
        Answer("k02", "c", "tak"),
    ]
    c = infer(ans, {"k01": YN, "k02": YN}, {"c": (2, 0)})
    assert round(c.posterior["k01"]["tak"], 4) == REF_K01
    assert round(c.trust["c"], 4) == REF_TRUST_C


REF_K01 = 0.9706
REF_TRUST_C = 0.2344


def test_owner_prior_breaks_tie():
    ans = [Answer("k01", "owner", "tak"), Answer("k01", "x", "nie")]
    opts = {"k01": YN}
    assert abs(infer(ans, opts).posterior["k01"]["tak"] - 0.5) < 1e-9
    c = infer(ans, opts, owners={"owner"})
    assert c.truth("k01")[0] == "tak" and c.trust["owner"] > c.trust["x"]
