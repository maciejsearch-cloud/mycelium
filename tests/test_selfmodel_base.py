import pytest

from iot_mycelium.selfmodel import Check, Claim, ClaimKind, Decision, Measurement, Snapshot, Verdict, wilson


def m(**kw):
    base = dict(domain="lm/logika", source="samouk-probe", subject="LM v4", n=40, correct=9, wrong=31,
                evidence="sha", measured_at="2026-11-01T12:00:00+00:00", chance=0.25)  # fmt: skip
    return Measurement(**{**base, **kw})


def test_wilson_known_values():
    lo, hi = wilson(9, 40)
    assert lo == pytest.approx(0.1233, abs=1e-3) and hi == pytest.approx(0.3755, abs=1e-3)
    assert wilson(0, 0) == (0.0, 1.0)
    assert wilson(10, 10)[1] == 1.0


def test_measurement_counts_must_add_up():
    with pytest.raises(ValueError):
        m(correct=10, wrong=31)
    with pytest.raises(ValueError):
        m(n=-1)


def test_measurement_properties():
    x = m(n=14, correct=9, wrong=0, abstained=5, chance=None)
    assert x.accuracy == pytest.approx(9 / 14)
    assert x.precision == 1.0 and x.answered == 9
    assert x.abstain_rate == pytest.approx(5 / 14)
    assert m(n=3, correct=0, wrong=0, abstained=3).precision is None


def test_snapshot_json_roundtrip():
    c = Claim("poziom:lm/logika", ClaimKind.LEVEL, "lm/logika", "pl", "en", 0.225, 0.12, 0.38, 40, "samouk-probe",
              "sha", "2026-11-01T12:00:00+00:00")  # fmt: skip
    k = Check("poziom:lm/logika", Verdict.NO_NEW_EVIDENCE, 0.225, 0.12, 0.38, 40, "sha", "pl", "en")
    d = Decision("plan-3", "2026-11-01T11:00:00+00:00", "samouk-alloc", {"matematyka": 5}, "błąd duży")
    s = Snapshot("2026-11-01T12:00:00+00:00", "fp", {"lm": {"version": 4}}, [m()], [c], [k], [d], {"T": 2.8})
    j = s.to_json()
    assert j["claims"][0]["kind"] == "poziom" and j["checks"][0]["verdict"] == "brak_nowych_danych"
    assert Snapshot.from_json(j) == s


def test_snapshot_rejects_newer_schema():
    with pytest.raises(ValueError):
        Snapshot.from_json({"at": "x", "fingerprint": "y", "schema": 99})
