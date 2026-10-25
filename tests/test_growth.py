import pytest

from iot_mycelium.ai.consensus import Answer
from iot_mycelium.ai.growth import QA_PATH, latest_config, load_qa, run_once
from iot_mycelium.ai.learners import DEFAULT_CONFIG
from iot_mycelium.ai.node import Store

pytestmark = pytest.mark.skipif(not QA_PATH.exists(), reason="brak web/public/data/qa.json")


def test_growth_cycle_offline_logs_and_never_regresses(tmp_path, monkeypatch):
    monkeypatch.setenv("IOT_MYCELIUM_NODE_DIR", str(tmp_path))
    store = Store(offline=True)
    qa = load_qa()
    iqs = []
    for i in range(3):
        r = run_once(store, qa, seed=i)
        iqs.append(r["metrics"]["iq"])
    assert iqs == sorted(iqs)  # zmiany tylko gdy wynik rośnie
    events = {g["event"] for g in store.local["growth"]}
    assert {"goal", "action"} <= events and ({"accept", "reject", "spawn", "prune"} & events)
    assert store.local["outbox"]  # offline: wpisy czekają na wysłanie
    assert (tmp_path / "local.json").exists()


def test_latest_config_merges_and_ignores_garbage():
    g = [
        {"event": "reject", "detail": {}},
        {"event": "accept", "detail": {"config": {"intent": {"lr": 0.2, "evil": 1}, "sensor": {}}}},
    ]
    cfg = latest_config(g)
    assert cfg["intent"]["lr"] == 0.2 and "evil" not in cfg["intent"]
    assert latest_config([]) == DEFAULT_CONFIG


def test_answer_owner_flag_dataclass():
    assert Answer("k01", "n", "tak", True).owner
