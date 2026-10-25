"""GPU w węźle PC: wykrywanie kart (WMI), decyzja testu CPU vs DirectML, blokady włączenia, propozycja RAM."""

import json

import pytest
import torch

from iot_mycelium.mesh import gpu, sched, selfupdate, sysmon
from iot_mycelium.mesh.account import NodeAccount, Store
from iot_mycelium.mesh.history import History

WMI = json.dumps(
    [
        {
            "Name": "AMD Radeon(TM) Graphics",
            "AdapterRAM": 536870912,
            "DriverVersion": "31.0.21912.14",
            "PNPDeviceID": "x",
        },
        {"Name": "Microsoft Basic Display Adapter", "AdapterRAM": 0},
        {"Name": "Microsoft Remote Display Adapter"},
    ]
)


def test_parse_wmi_real_names_and_skips_virtual():
    a = sysmon._parse_wmi(WMI)
    assert [x["name"] for x in a] == ["AMD Radeon(TM) Graphics"]
    assert a[0]["vendor"] == "AMD" and a[0]["vram_mb"] == 512 and "WMI" in a[0]["source"]
    assert sysmon._parse_wmi(json.dumps({"Name": "Intel(R) UHD Graphics"}))[0]["vendor"] == "Intel"
    assert sysmon._parse_wmi("") == [] and sysmon._parse_wmi("not json") == []


class FakeModel:
    dtype = torch.bfloat16
    emb = norm = cos = sin = torch.zeros(2, 2)
    L = [{"w": torch.zeros(2, 2)}] * 6


def _bench(monkeypatch, tmp_path, cpu_s, gpu_runs):
    """gpu_runs: dtype → (loss0, s/krok) albo wyjątek; CPU: loss0 = 3.0."""
    monkeypatch.setenv("MYC_CACHE", str(tmp_path))
    monkeypatch.setattr(gpu, "dml_available", lambda: True)
    monkeypatch.setattr(gpu, "dml_device", lambda: "dml")
    monkeypatch.setattr(gpu, "dml_name", lambda: "AMD Radeon(TM) Graphics")

    def steps(model, dev, ids, mask, n):
        if dev is None:
            return [3.0, 2.9, 2.8], cpu_s
        r = gpu_runs[str(model.dtype).replace("torch.", "")]
        if isinstance(r, Exception):
            raise r
        return [r[0], r[0], r[0]], r[1]

    monkeypatch.setattr(gpu, "_steps", steps)
    monkeypatch.setattr(gpu.DevModel, "__init__", lambda s, m, dev, dt, layers=None: setattr(s, "dtype", dt))
    monkeypatch.setattr(gpu.DevModel, "full_bytes", lambda s: 950 * 2**20)
    return gpu.benchmark(FakeModel(), torch.zeros(2, 8), torch.ones(2, 8), log=lambda *a: None)


def test_bench_enables_only_when_faster_and_sane(monkeypatch, tmp_path):
    r = _bench(monkeypatch, tmp_path, 1.0, {"float16": (3.01, 0.4)})
    assert r["ok"] and r["dtype"] == "float16" and r["gpu"][0]["speedup"] == 2.5
    assert gpu.load_bench()["ok"]  # zapisane do pokazania w panelu


def test_bench_rejects_slower_gpu(monkeypatch, tmp_path):
    r = _bench(monkeypatch, tmp_path, 0.5, {"float16": (3.0, 0.8)})
    assert not r["ok"] and "wolniejsze" in r["reason"]


def test_bench_rejects_wrong_loss_then_tries_f32(monkeypatch, tmp_path):
    r = _bench(monkeypatch, tmp_path, 1.0, {"float16": (float("nan"), 0.1), "float32": (3.5, 0.5)})
    assert not r["ok"] and [g["dtype"] for g in r["gpu"]] == ["float16", "float32"]
    r = _bench(monkeypatch, tmp_path, 1.0, {"float16": RuntimeError("op not supported"), "float32": (3.02, 0.5)})
    assert r["ok"] and r["dtype"] == "float32" and "error" in r["gpu"][0]


def test_bench_without_directml_is_honest(monkeypatch, tmp_path):
    monkeypatch.setenv("MYC_CACHE", str(tmp_path))
    monkeypatch.setattr(gpu, "dml_available", lambda: False)
    monkeypatch.setattr(gpu, "_steps", lambda *a: ([3.0], 1.0))
    monkeypatch.setattr(gpu.DevModel, "__init__", lambda s, *a, **k: None)
    r = gpu.benchmark(FakeModel(), torch.zeros(2, 8), torch.ones(2, 8), log=lambda *a: None)
    assert not r["ok"] and "gpu" not in r and "DirectML" in r["reason"]


@pytest.fixture
def panel(tmp_path, monkeypatch):
    monkeypatch.setenv("MYC_CACHE", str(tmp_path))
    from iot_mycelium.mesh.dashboard import Panel

    acc = NodeAccount("n1", store=Store(tmp_path / "a.json", use_keyring=False), post=None, log=lambda *a: None)
    return Panel("t", "n1", sched.defaults(1, 0), History("t"), sysmon.Monitor(), acc, log=lambda *a: None)


def test_gpu_enable_refused_without_directml_or_bench(panel, monkeypatch):
    monkeypatch.setattr(gpu, "dml_available", lambda: False)
    ok, msg = panel.gpu_can_enable()
    assert not ok and "DirectML" in msg
    monkeypatch.setattr(gpu, "dml_available", lambda: True)
    ok, msg = panel.gpu_can_enable()
    assert not ok and "test GPU" in msg


def test_gpu_enable_refused_when_ram_short(panel, monkeypatch):
    monkeypatch.setattr(gpu, "dml_available", lambda: True)
    monkeypatch.setattr(
        gpu,
        "load_bench",
        lambda: {"ok": True, "dtype": "float16", "gpu": [{"dtype": "float16", "approx_model_mb": 950}]},
    )
    panel.monitor.samples.append({"ram_total": 8 * 2**30, "ram_used": int(7.4 * 2**30)})
    ok, msg = panel.gpu_can_enable()
    assert not ok and "pamięci" in msg
    panel.monitor.samples.append({"ram_total": 8 * 2**30, "ram_used": 4 * 2**30})
    assert panel.gpu_can_enable()[0]


def test_ram_suggestion_for_8gb(panel):
    panel.monitor.samples.append({"ram_total": int(7.4 * 2**30), "ram_used": 6 * 2**30})
    assert panel.gpu_state()["ram_suggest_gb"] == 3
    panel.monitor.samples.append({"ram_total": 16 * 2**30, "ram_used": 6 * 2**30})
    assert panel.gpu_state()["ram_suggest_gb"] is None


def test_selfupdate_key_stays_on_cpu_variant_here():
    assert selfupdate.os_key() in ("linux", "macos", "windows")
