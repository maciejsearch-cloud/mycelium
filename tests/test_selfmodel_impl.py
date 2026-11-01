import math

import pytest

from iot_mycelium.selfmodel import ClaimKind, Measurement, Snapshot, Verdict
from iot_mycelium.selfmodel.calibration import TemperatureCalibrator, ece, evaluate, nll, softmax, split_half
from iot_mycelium.selfmodel.model import (
    MeasuredSelfModel,
    check_claims,
    check_confidence,
    claims_for,
    decisions_from_plans,
)
from iot_mycelium.selfmodel.sources import lm_eval_measurement, samouk_measurements, school_measurements
from iot_mycelium.selfmodel.store import SupabaseSelfStore, lit

AT = "2026-11-01T12:00:00+00:00"


def lm_m(correct=9, n=40, evidence="lm-v4|probe-a", conf=None):
    return Measurement("lm/logika", "samouk-probe", "LM v4", n, correct, n - correct, evidence, AT, chance=0.25,
                       conf_raw=conf, conf_cal=conf, ece_raw=0.1 if conf else None, ece_cal=0.05 if conf else None)  # fmt: skip


# ---------------------------------------------------------------- kalibracja
def test_softmax_temperature_flattens():
    p1, p3 = softmax([2.0, 0.0, 0.0, 0.0]), softmax([2.0, 0.0, 0.0, 0.0], 3.0)
    assert sum(p1) == pytest.approx(1) and p3[0] < p1[0]


def test_ece_perfect_and_overconfident():
    assert ece([0.25] * 4, [True, False, False, False]) == pytest.approx(0.0)
    assert ece([0.95] * 10, [True] * 5 + [False] * 5) == pytest.approx(0.45)


def test_temperature_fit_recovers_overconfidence():
    # prawdziwy rozkład: trafność 40% przy logitach mówiących ~85% → dopasowana T > 1 i niższa NLL
    logits = [[3.0, 0.0, 0.0, 0.0]] * 100
    answers = [0] * 40 + [1] * 20 + [2] * 20 + [3] * 20
    cal = TemperatureCalibrator()
    cal.fit(logits, answers, source="test")
    assert cal.t > 1.5
    assert nll(logits, answers, cal.t) < nll(logits, answers, 1.0)
    rep = evaluate(logits, answers, cal)
    assert rep["ece_cal"] < rep["ece_raw"]
    assert rep["conf_cal"] == pytest.approx(0.4, abs=0.03)
    assert cal.params()["n_fit"] == 100


def test_split_half_is_deterministic_and_disjoint():
    a, b = split_half(7)
    assert a == [0, 2, 4, 6] and b == [1, 3, 5] and not set(a) & set(b)


# ---------------------------------------------------------------- źródła
def test_lm_eval_measurement_uses_held_out_half():
    scores = [[0.0, -1.0, -1.0, -1.0]] * 6 + [[-1.0, 0.0, -1.0, -1.0]] * 4
    answers = [0] * 10
    m, rep = lm_eval_measurement(scores, answers, 4, "a" * 64, AT)
    assert (m.n, m.correct, m.wrong, m.domain) == (10, 6, 4, "lm/definicje")
    assert rep["n_held_out"] == 5 and m.chance == 0.25
    assert m.conf_n == 5 and m.held_out() == (m.conf_correct, 5) and m.temperature == rep["params"]["T"]
    with pytest.raises(ValueError):
        lm_eval_measurement([], [], 4, "a", AT)


def plan(pid, alloc, stats, items=None, cand=None, version=4):
    return {"id": pid, "at": f"2026-11-01T0{pid}:00:00+00:00", "alloc": alloc, "wiki_jobs": 3,
            "why": {t: {"reason": f"powód {t}"} for t in alloc},
            "stats": stats, "measured": {"base": {"version": version}, "probe_sha": "p" * 64, "cand": cand,
                                         **({"items": items} if items else {})}}  # fmt: skip


def test_samouk_measurements_with_and_without_items():
    st = {"logika": {"acc": 0.5, "n": 4, "p_right": 0.4, "progress": None}}
    items = {"logika": [[[0.7, 0.1, 0.1, 0.1], 0], [[0.7, 0.1, 0.1, 0.1], 1], [[0.1, 0.6, 0.2, 0.1], 1],
                        [[0.4, 0.3, 0.2, 0.1], 3]]}  # fmt: skip
    (m,), reps = samouk_measurements(plan(1, {"logika": 2}, st, items), items)
    assert (m.correct, m.n) == (2, 4) and m.conf_raw is not None and m.conf_n == 2 and "lm/logika" in reps
    (m2,), reps2 = samouk_measurements(plan(1, {"logika": 2}, st), None)
    assert (m2.correct, m2.conf_raw, reps2) == (2, None, {})
    with pytest.raises(ValueError):
        samouk_measurements(plan(1, {}, {"logika": {**st["logika"], "n": 5}}), items)


def test_school_measurements_latest_run_with_abstentions():
    w = {"set": "szkolne_v1", "sha256": "f" * 64, "runs": [
        {"when": "a", "n": 2, "ok": 0, "zle": 1, "nie_wiem": 1, "per_grade": {}},
        {"when": "b", "n": 30, "ok": 20, "zle": 1, "nie_wiem": 9, "per_grade": {"1": {"n": 14, "ok": 9, "zle": 0, "nie_wiem": 5}}},
    ]}  # fmt: skip
    ms = school_measurements(w)
    assert [m.domain for m in ms] == ["czysta/wszystkie", "czysta/klasa-1"]
    assert ms[0].abstained == 9 and ms[0].evidence.endswith("|b")
    assert school_measurements({"runs": []}) == []


# ---------------------------------------------------------------- twierdzenia i kontrola
def test_level_claim_low_confidence_wording_and_interval():
    (c,) = claims_for(lm_m(9, 40), AT)
    assert c.kind is ClaimKind.LEVEL and "niska" in c.text_pl and "9/40" in c.text_pl and "22,5%" in c.text_pl
    assert "22.5%" in c.text_en
    assert c.low < 0.225 < c.high
    (c2,) = claims_for(lm_m(30, 40), AT)
    assert "lepsza niż zgadywanie" in c2.text_pl and "nieco" not in c2.text_pl
    assert claims_for(lm_m(3, 8), AT) == []  # n < 10: nic nie twierdzimy


def test_school_claims_precision_and_abstention():
    m = Measurement("czysta/klasa-3", "szkolne_v1", "czysta", 36, 22, 0, "ev", AT, abstained=14)
    kinds = {c.kind for c in claims_for(m, AT)}
    assert kinds == {ClaimKind.PRECISION, ClaimKind.ABSTENTION}


def test_check_claims_verdicts():
    (c,) = claims_for(lm_m(9, 40, "lm-v4|probe-a"), AT)
    same = check_claims([c], [lm_m(9, 40, "lm-v4|probe-a")])[0]
    assert same.verdict is Verdict.NO_NEW_EVIDENCE
    near = check_claims([c], [lm_m(11, 40, "lm-v5|probe-a")])[0]
    assert near.verdict is Verdict.CONSISTENT
    far = check_claims([c], [lm_m(380, 400, "lm-v5|probe-a")])[0]
    assert far.verdict is Verdict.INCONSISTENT
    gone = check_claims([c], [])[0]
    assert gone.verdict is Verdict.INSUFFICIENT


def test_check_confidence_uses_held_out_counts():
    m = Measurement("lm/x", "s", "LM", 40, 30, 10, "e", AT, chance=0.25, conf_raw=0.3, conf_cal=0.3, ece_raw=0.1,
                    ece_cal=0.1, conf_n=20, conf_correct=6, temperature=2.0)  # fmt: skip
    res = {c.claim_id: c for c in check_confidence([m])}
    assert res["pewnosc-skalibrowana:lm/x"].verdict is Verdict.CONSISTENT  # 6/20 = 30%, nie 30/40
    assert res["pewnosc-skalibrowana:lm/x"].n == 20 and "6/20" in res["pewnosc-skalibrowana:lm/x"].detail_pl


def test_check_confidence_flags_overconfidence():
    over = lm_m(143, 400, conf=0.485)
    res = {c.claim_id: c.verdict for c in check_confidence([over])}
    assert res["pewnosc-surowa:lm/logika"] is Verdict.INCONSISTENT
    ok = lm_m(143, 400, conf=0.36)
    assert all(c.verdict is Verdict.CONSISTENT for c in check_confidence([ok]))


def test_decisions_outcome_from_next_plan():
    p1 = plan(1, {"matematyka": 5, "logika": 0}, {"matematyka": {"acc": 0.2, "n": 40}})
    p2 = plan(
        2,
        {"logika": 4},
        {"matematyka": {"acc": 0.4, "n": 40, "progress": 0.175}},
        cand={"id": 51, "status": "rejected"},
    )
    d1, d2 = decisions_from_plans([p2, p1])
    assert d1.choice == {"matematyka": 5} and d1.reason == "powód matematyka"
    assert d1.outcome["progress"] == {"matematyka": 0.175} and "#51" in d1.outcome_pl and "+17.5" in d1.outcome_pl
    assert d2.outcome is None


def test_selfmodel_snapshot_roundtrip_and_fingerprint():
    state = {"lm": {"version": 4, "base": "Qwen2.5-0.5B-Instruct", "rank": 4, "params": 368640}}
    p = plan(1, {"matematyka": 5}, {"matematyka": {"acc": 0.2, "n": 40}})
    sm = MeasuredSelfModel(state, {"params": {"T": 2.8}}, p, AT)
    sm.observe([lm_m(conf=0.3)])
    sm.record(decisions_from_plans([p]))
    with pytest.raises(ValueError):
        sm.observe([lm_m()])
    snap = sm.snapshot()
    assert {c.id for c in snap.claims} >= {"stan:lm", "stan:nauka", "poziom:lm/logika", "kalibracja:lm/logika"}
    assert "368 640" in next(c.text_pl for c in snap.claims if c.id == "stan:lm")
    assert Snapshot.from_json(snap.to_json()) == snap
    sm2 = MeasuredSelfModel(state, {"params": {"T": 2.8}}, p, "2026-11-02T00:00:00+00:00")
    sm2.observe([lm_m(conf=0.3)])
    sm2.record(decisions_from_plans([p]))
    assert sm2.fingerprint() == sm.fingerprint()  # czas migawki nie zmienia odcisku
    checks = sm2.check(snap)
    assert any(c.verdict is Verdict.NO_NEW_EVIDENCE for c in checks)


def test_store_write_requires_owner_and_quotes_sql():
    st = SupabaseSelfStore("https://x.invalid", "k")
    snap = Snapshot(AT, "0" * 32, {}, [], [])
    with pytest.raises(PermissionError):
        st.save(snap)
    sent = []
    st2 = SupabaseSelfStore("https://x.invalid", "k", lambda q: sent.append(q) or [{"id": 1}])
    assert st2.save(Snapshot(AT, "0" * 32, {"x": "it's"}, [], []))
    assert "it''s" in sent[0] and sent[1] == "select myc_self_model_gc()"
    assert lit("a'b") == "'a''b'"


def test_math_sanity():
    assert math.isclose(sum(softmax([1, 2, 3], 0.5)), 1.0)


def test_relations_extension_point_roundtrip():
    rel = {"source": "myc_self_relations", "available": False, "public_rows": 0}
    sm = MeasuredSelfModel({}, {}, None, AT, relations=rel)
    snap = sm.snapshot()
    assert snap.relations == rel and Snapshot.from_json(snap.to_json()).relations == rel
