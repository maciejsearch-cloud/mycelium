"""Tryb pasywny: domyślnie wyłączony, świadek wykrywa niespójne wyniki, limity transferu, tylko adresy projektu."""

import base64

import pytest
import torch

from iot_mycelium.mesh import lm, sched
from iot_mycelium.mesh.passive import Budget, check_train_result, fetch


def _row(**kw):
    torch.manual_seed(0)
    u = lm.Lora.init(0)
    for t in u.tensors():
        t.copy_(torch.randn_like(t) * 0.01)
    tok = 4096
    row = {
        "payload": base64.b64encode(u.to_bytes({"base": 1})).decode(),
        "metrics": {"tokens": tok},
        "samples": tok,
        "flops": tok * lm.FLOPS_TRAIN_TOKEN,
        "ms": 60_000,
    }
    row.update(kw)
    return row


def test_passive_is_opt_in():
    a = sched.sanitize({}, sched.defaults(2, 0))
    assert a["passive"]["on"] is False and a["compute_on"] is True
    a = sched.sanitize({"passive": {"on": True, "disk_gb": 9999, "daily_gb": 0}}, sched.defaults(2, 0))
    assert a["passive"]["on"] and a["passive"]["disk_gb"] == 500 and a["passive"]["daily_gb"] == 0.05
    s = sched.Scheduler({**a, "compute_on": False})
    assert not s.allowed("lm_train")  # bez oddawania mocy: żadnych zadań obliczeniowych


def test_witness_accepts_consistent_and_flags_fake():
    assert check_train_result(_row())["ok"]
    r = check_train_result(_row(flops=1e15))  # zawyżony wkład
    assert not r["ok"] and not r["checks"]["flops_match"]
    r = check_train_result(_row(ms=1))  # niemożliwie szybko
    assert not r["ok"] and not r["checks"]["speed_ok"]
    r = check_train_result(_row(payload="AAAA"))
    assert not r["ok"] and not r["checks"]["adapter_ok"]
    r = check_train_result(_row(samples=1))
    assert not r["checks"]["tokens_match"]


def test_budget_and_allowed_hosts(tmp_path):
    b = Budget(tmp_path / "u.json")
    assert b.left(1) == 2**30
    b.add("down", 2**29)
    assert Budget(tmp_path / "u.json").left(1) == 2**29
    with pytest.raises(ValueError):
        fetch("https://evil.example/x")
