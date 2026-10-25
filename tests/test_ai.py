"""Testy Mycelium AI na danych syntetycznych (bez pobierania – CI)."""

import json

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from iot_mycelium.ai import federated as fed  # noqa: E402
from iot_mycelium.ai.datasets import TASKS, load_task  # noqa: E402
from iot_mycelium.ai.models import build_model, default_spec  # noqa: E402
from iot_mycelium.ai.mqtt import RateLimiter, handle  # noqa: E402
from iot_mycelium.ai.orchestrator import Budget, Orchestrator, load_model  # noqa: E402
from iot_mycelium.ai.score import mbs  # noqa: E402
from iot_mycelium.ai.training import TrainConfig, evaluate, train_model  # noqa: E402
from iot_mycelium.ai.vector_memory import VectorMemory, task_embedding  # noqa: E402


@pytest.fixture(autouse=True)
def ai_home(tmp_path, monkeypatch):
    monkeypatch.setenv("IOT_MYCELIUM_AI_DIR", str(tmp_path / "ai"))
    monkeypatch.setenv("IOT_MYCELIUM_AI_RESULTS", str(tmp_path / "ai" / "r.json"))
    torch.set_num_threads(2)
    return tmp_path / "ai"


@pytest.mark.parametrize("name", TASKS)
def test_task_trains_above_chance(name):
    t = load_task(name, synthetic=True)
    assert len(t.X_train) and len(t.X_test) and len(t.X_val)
    m = build_model(default_spec(name), t)
    before = evaluate(m, t, t.X_test, t.y_test)["score"]
    train_model(m, t, t.X_train, t.y_train, TrainConfig(epochs=3, lr=3e-3))
    after = evaluate(m, t, t.X_test, t.y_test)["score"]
    assert after >= before
    assert 0.0 <= after <= 1.0


def _states(n=3, seed=0):
    g = torch.Generator().manual_seed(seed)
    base = {"w": torch.zeros(4, 3), "b": torch.zeros(3), "n": torch.tensor(0)}
    clients = [
        {"w": torch.randn(4, 3, generator=g), "b": torch.randn(3, generator=g), "n": torch.tensor(i)} for i in range(n)
    ]
    return base, clients


def test_fedavg_is_weighted_mean():
    base, clients = _states()
    new, _ = fed.aggregate(base, clients, [1, 2, 3])
    want = sum(w * c["w"] for w, c in zip([1, 2, 3], clients)) / 6
    assert torch.allclose(new["w"], want, atol=1e-5)
    assert new["n"].dtype == torch.int64


def test_secure_aggregation_matches_plain_and_masks_cancel():
    base, clients = _states(4)
    plain, _ = fed.aggregate(base, clients, [1, 1, 2, 2])
    sec, _ = fed.aggregate(base, clients, [1, 1, 2, 2], secure_agg=True, seed=3)
    assert torch.allclose(plain["w"], sec["w"], atol=1e-4)
    assert torch.stack(fed.pairwise_masks(4, 10, 1)).sum(0).abs().max() < 1e-4


def test_dp_clipping_bounds_update():
    base, clients = _states()
    _, info = fed.aggregate(base, clients, [1, 1, 1], dp_clip=0.5)
    assert info["clipped"] == 3 and info["update_norm"] <= 0.5 + 1e-5


def test_partition_dirichlet_covers_all_samples():
    t = load_task("fashion_mnist", synthetic=True)
    parts = fed.partition(t, 4, "dirichlet", alpha=0.3)
    assert sum(len(p) for p in parts) <= len(t.y_train)
    assert len(np.unique(np.concatenate(parts))) == sum(len(p) for p in parts)


def test_federated_beats_nothing_and_reports():
    t = load_task("har", synthetic=True)
    r = fed.compare(t, default_spec("har"), fed.FedConfig(n_clients=3, rounds=2), TrainConfig(epochs=1))
    for k in ("local", "fedavg", "fedprox", "fed_private", "centralized"):
        assert 0.0 <= r[k]["test"]["score"] <= 1.0
    assert r["fedavg"]["comm_mb"] > 0 and len(r["fedavg"]["history"]) == 2


def test_vector_memory_search_and_persist(tmp_path):
    mem = VectorMemory(tmp_path / "m")
    a, b = load_task("har", synthetic=True), load_task("intents", synthetic=True)
    mem.add(task_embedding(a), {"task": "har"})
    mem.add(task_embedding(b), {"task": "intents"})
    assert mem.search(task_embedding(a), k=1)[0]["task"] == "har"
    assert mem.search(task_embedding(a), k=1, where={"task": "intents"})[0]["task"] == "intents"
    mem.save()
    assert len(VectorMemory(tmp_path / "m")) == 2
    with pytest.raises(ValueError):
        mem.add(np.ones(3), {})


def test_score():
    assert mbs({"a": 1.0, "b": 0.5}) == 75.0 and mbs({}) == 0.0 and mbs({"a": 2}) == 100.0


def test_orchestrator_quick_and_api(ai_home):
    res = Orchestrator(budget=Budget.quick(), synthetic=True, fresh_memory=True).run()
    assert len(res["agents"]) == 4 and res["memory"]["size"] == 4 and len(res["federated"]) == 2
    assert res["agents"][-1]["tuning"]["warm_start"] is not None  # pamięć grzybni podpowiada start
    assert load_model("har") is not None
    (ai_home / "r.json").write_text(json.dumps(res, default=str))

    from fastapi.testclient import TestClient

    from iot_mycelium.ai.api import app

    c = TestClient(app)
    assert c.get("/api/health").json()["results"] is True
    assert c.get("/api/ai/results").json()["mbs"] == res["mbs"]
    assert c.get("/api/snapshot").json()["ai"]["mbs"] == res["mbs"]
    assert c.get("/api/ai/memory").json()["size"] == 4
    top = c.post("/api/ai/intent", json={"text": "what is my balance"}).json()["top"]
    assert len(top) == 3 and abs(sum(t["p"] for t in top)) <= 1.0001
    assert "next" in c.post("/api/ai/forecast", json={"values": [1, 2, 3, 4]}).json()
    assert c.post("/api/ai/runs").status_code == 403
    assert c.post("/api/ai/intent", json={"text": ""}).status_code == 422
    assert c.post("/api/ai/forecast", content=b'{"values": [1, NaN, 3]}').status_code == 422
    with c.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "hello"


def test_mqtt_handle():
    out = handle("mycelium/sensors/dev7", b'{"values": [1, 2, 3]}', lambda v: {"next": v[-1]})
    assert out == ("mycelium/forecast/dev7", '{"next": 3.0}')
    assert handle("mycelium/sensors/x", b"nope", lambda v: {}) is None
    assert handle("mycelium/sensors/x", b'{"values": [1]}', lambda v: {}) is None


def test_mqtt_handle_rejects_bad_input():
    ok = b'{"values": [1, 2, 3]}'
    echo = lambda v: {"next": v[-1]}  # noqa: E731
    assert handle("mycelium/sensors/dev 7", ok, echo) is None  # niedozwolone znaki w ID
    assert handle("mycelium/sensors/" + "a" * 65, ok, echo) is None
    assert handle("mycelium/sensors/x", b'{"values": [1, NaN, 3]}', echo) is None
    assert handle("mycelium/sensors/x", b'{"values": [1, Infinity]}', echo) is None
    big = json.dumps({"values": [1.0] * 5000}).encode()
    assert handle("mycelium/sensors/x", big, echo) is None  # > MAX_PAYLOAD


def test_rate_limiter_per_device():
    t = [0.0]
    lim = RateLimiter(rate=1.0, burst=2, clock=lambda: t[0])
    msg = b'{"values": [1, 2]}'
    got = [handle("mycelium/sensors/a", msg, lambda v: {}, lim) is not None for _ in range(3)]
    assert got == [True, True, False]
    assert handle("mycelium/sensors/b", msg, lambda v: {}, lim) is not None  # osobny kubełek
    t[0] = 1.0
    assert handle("mycelium/sensors/a", msg, lambda v: {}, lim) is not None


@pytest.mark.skipif(
    not __import__("shutil").which("mosquitto") and not __import__("os").path.exists("/usr/sbin/mosquitto"),
    reason="brak brokera mosquitto",
)
def test_mqtt_roundtrip_with_broker():
    import socket
    import subprocess
    import threading
    import time

    import paho.mqtt.client as mqtt

    from iot_mycelium.ai import mqtt as bridge

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    exe = __import__("shutil").which("mosquitto") or "/usr/sbin/mosquitto"
    broker = subprocess.Popen([exe, "-p", str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # noqa: S603
    try:
        time.sleep(0.5)
        got: list[bytes] = []

        def fake_serve():
            c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
            c.on_connect = lambda cl, *_: cl.subscribe(bridge.IN_TOPIC)

            def on_msg(cl, _u, msg):
                out = bridge.handle(msg.topic, msg.payload, lambda v: {"next": v[-1]})
                if out:
                    cl.publish(*out)
                cl.disconnect()

            c.on_message = on_msg
            c.connect("127.0.0.1", port)
            c.loop_forever()

        threading.Thread(target=fake_serve, daemon=True).start()
        sub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        sub.on_message = lambda *a: got.append(a[2].payload)
        sub.connect("127.0.0.1", port)
        sub.subscribe("mycelium/forecast/#")
        sub.loop_start()
        time.sleep(0.7)
        sub.publish("mycelium/sensors/d1", b'{"values": [1, 2, 5]}')
        for _ in range(30):
            if got:
                break
            time.sleep(0.1)
        sub.loop_stop()
        assert got == [b'{"next": 5.0}']
    finally:
        broker.terminate()
