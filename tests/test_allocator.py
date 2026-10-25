import random

from iot_mycelium.mesh import allocator as al

T = ["lm", "taxo", "images"]


def test_equal_until_stages_done_or_no_data():
    assert al.weights(T, [al.Gain("lm", 5, 1)], stages_done=False) == {t: 1 / 3 for t in T}
    assert al.weights(T, [], stages_done=True) == {t: 1 / 3 for t in T}


def test_gain_per_compute_with_floor():
    w = al.weights(T, [al.Gain("lm", 10, 1), al.Gain("taxo", 1, 10), al.Gain("images", 0, 5)], True)
    assert abs(sum(w.values()) - 1) < 1e-9
    assert w["lm"] > w["taxo"] > w["images"] >= al.MIN_SHARE
    assert abs(w["images"] - al.MIN_SHARE) < 1e-9


def test_pick_deterministic():
    w = {"lm": 0.9, "taxo": 0.1}
    assert [al.pick(w, random.Random(1)) for _ in range(3)] == [al.pick(w, random.Random(1)) for _ in range(3)]
