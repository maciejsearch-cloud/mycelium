import json
import multiprocessing as mp
import threading

import numpy as np
import pytest

from iot_mycelium.memory import MyceliumMemory, shape_signature

SHAPES = {"W1": (2, 4), "b1": (1, 4), "W2": (4, 1), "b2": (1, 1)}


def _weights(value: float = 0.5):
    return {k: np.full(s, value) for k, s in SHAPES.items()}


def test_empty_memory_returns_random_weights(tmp_path):
    mem = MyceliumMemory(tmp_path / "m.json")
    assert mem.is_empty()
    w = mem.get_fusion_weights(SHAPES)
    assert {k: v.shape for k, v in w.items()} == SHAPES
    assert np.all(w["b1"] == 0)


def test_update_only_when_loss_improves(tmp_path):
    mem = MyceliumMemory(tmp_path / "m.json")
    assert mem.update_memory(_weights(), 0.5, {"agent_id": "a1"})
    assert not mem.update_memory(_weights(), 0.8, {"agent_id": "a2"})
    assert mem.update_memory(_weights(), 0.2, {"agent_id": "a3"})
    stats = mem.get_stats()
    assert stats["best_loss"] == pytest.approx(0.2)
    assert stats["total_updates"] == 2
    assert mem.get_metadata()["best_agent_id"] == "a3"


def test_non_finite_loss_is_rejected(tmp_path):
    mem = MyceliumMemory(tmp_path / "m.json")
    assert not mem.update_memory(_weights(), float("nan"))
    assert not mem.update_memory(_weights(), float("inf"))
    assert mem.is_empty()


def test_fusion_alpha_blending(tmp_path):
    mem = MyceliumMemory(tmp_path / "m.json")
    mem.update_memory(_weights(1.0), 0.1)
    full = mem.get_fusion_weights(SHAPES, alpha=1.0)
    assert np.allclose(full["W1"], 1.0)
    half = mem.get_fusion_weights(SHAPES, alpha=0.5, rng=np.random.default_rng(0))
    rand = MyceliumMemory._generate_random_weights(SHAPES, np.random.default_rng(0))
    assert np.allclose(half["W1"], 0.5 + 0.5 * rand["W1"])
    with pytest.raises(ValueError):
        mem.get_fusion_weights(SHAPES, alpha=1.5)


OTHER = {"W1": (3, 8), "b1": (1, 8), "W2": (8, 1), "b2": (1, 1)}


def _other(value: float):
    return {k: np.full(s, value) for k, s in OTHER.items()}


def test_slots_per_shape_coexist(tmp_path):
    mem = MyceliumMemory(tmp_path / "m.json")
    assert mem.update_memory(_weights(1.0), 0.1, {"task_name": "xor"})
    # inna architektura z GORSZYM loss nie kasuje już slotu XOR – dostaje własny slot
    assert mem.update_memory(_other(2.0), 0.9, {"task_name": "majority"})
    assert mem.get_best_loss(SHAPES) == pytest.approx(0.1)
    assert mem.get_best_loss(OTHER) == pytest.approx(0.9)
    assert np.allclose(mem.get_fusion_weights(SHAPES, alpha=1.0)["W1"], 1.0)
    assert np.allclose(mem.get_fusion_weights(OTHER, alpha=1.0)["W1"], 2.0)
    stats = mem.get_stats()
    assert stats["slots"] == 2 and stats["total_updates"] == 2 and stats["best_loss"] == pytest.approx(0.1)
    assert {r["task_name"] for r in mem.list_slots()} == {"xor", "majority"}
    assert mem.get_metadata(OTHER)["task_name"] == "majority"


def test_slot_record_is_per_shape(tmp_path):
    mem = MyceliumMemory(tmp_path / "m.json")
    mem.update_memory(_weights(1.0), 0.1)
    # loss 0.5 jest gorszy od globalnego rekordu, ale to pierwszy wynik w tym slocie
    assert mem.update_memory(_other(1.0), 0.5)
    assert not mem.update_memory(_other(1.0), 0.6)
    assert mem.get_stats(OTHER)["total_updates"] == 1


def test_unknown_shape_gets_random_weights(tmp_path):
    mem = MyceliumMemory(tmp_path / "m.json")
    mem.update_memory(_weights(1.0), 0.1)
    fused = mem.get_fusion_weights(OTHER, alpha=1.0)
    assert fused["W1"].shape == (3, 8) and not np.allclose(fused["W1"], 1.0)
    assert mem.is_empty(OTHER) and not mem.is_empty(SHAPES)


def test_reset_single_slot(tmp_path):
    mem = MyceliumMemory(tmp_path / "m.json")
    mem.update_memory(_weights(1.0), 0.1)
    mem.update_memory(_other(1.0), 0.2)
    mem.reset(OTHER)
    assert mem.is_empty(OTHER) and not mem.is_empty(SHAPES)


def test_v1_file_is_migrated(tmp_path):
    path = tmp_path / "m.json"
    v1 = {
        "best_loss": 0.25,
        "best_weights": {k: np.full(s, 0.3).tolist() for k, s in SHAPES.items()},
        "metadata": {
            "created_at": "2026-10-01T00:00:00",
            "last_updated": "2026-10-02T00:00:00",
            "total_updates": 7,
            "best_agent_id": "xor_8_0.3",
            "task_name": "xor",
        },
    }
    path.write_text(json.dumps(v1))
    mem = MyceliumMemory(path)
    assert mem.get_best_loss(SHAPES) == pytest.approx(0.25)
    assert np.allclose(mem.get_fusion_weights(SHAPES, alpha=1.0)["W1"], 0.3)
    assert mem.get_stats()["total_updates"] == 7
    assert json.loads(path.read_text())["version"] == 2


def test_shape_signature_is_order_independent():
    assert shape_signature({"b": (1,), "a": (2, 3)}) == shape_signature({"a": (2, 3), "b": (1,)}) == "a=2x3;b=1"


def test_corrupted_file_recovers(tmp_path):
    path = tmp_path / "m.json"
    MyceliumMemory(path)
    path.write_text('{"best_loss": 0.1, "best_wei')  # ucięty zapis
    mem = MyceliumMemory(path)
    assert mem.is_empty()


def test_reset(tmp_path):
    mem = MyceliumMemory(tmp_path / "m.json")
    mem.update_memory(_weights(), 0.3)
    mem.reset()
    assert mem.is_empty() and mem.get_stats()["total_updates"] == 0


def test_concurrent_threads_no_lost_updates(tmp_path):
    path = tmp_path / "m.json"
    losses = [float(x) for x in np.linspace(1.0, 0.01, 40)]
    np.random.default_rng(0).shuffle(losses)

    def worker(chunk):
        mem = MyceliumMemory(path)
        for loss in chunk:
            mem.update_memory(_weights(loss), loss, {"agent_id": f"t{loss:.4f}"})

    threads = [threading.Thread(target=worker, args=(losses[i::8],)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    slot = json.loads(path.read_text())["slots"][shape_signature(SHAPES)]
    assert slot["best_loss"] == pytest.approx(min(losses))
    assert np.allclose(slot["best_weights"]["W1"], min(losses))


def _process_worker(path, losses):
    mem = MyceliumMemory(path)
    for loss in losses:
        mem.update_memory({k: np.full(s, loss) for k, s in SHAPES.items()}, loss)


@pytest.mark.slow
def test_concurrent_processes_keep_global_minimum(tmp_path):
    path = str(tmp_path / "m.json")
    MyceliumMemory(path)
    rng = np.random.default_rng(1)
    losses = [float(x) for x in rng.uniform(0.01, 1.0, 60)]
    ctx = mp.get_context("spawn")
    procs = [ctx.Process(target=_process_worker, args=(path, losses[i::4])) for i in range(4)]
    for p in procs:
        p.start()
    for p in procs:
        p.join(60)
        assert p.exitcode == 0
    mem = MyceliumMemory(path)
    assert mem.get_best_loss() == pytest.approx(min(losses))
    # wagi należą do tego samego zapisu co loss (brak „rozjechanego” stanu)
    slot = json.loads((tmp_path / "m.json").read_text())["slots"][shape_signature(SHAPES)]
    assert np.allclose(slot["best_weights"]["W1"], slot["best_loss"])
