"""Skład rundy modelu językowego: ~50% destylacji (α=0,15, T=1), reszta bez, plus zadanie na odłamku logiki (sft)."""

import asyncio
import importlib.util
import sys
from pathlib import Path

import pytest

pytest.importorskip("torch")
from iot_mycelium.mesh import lm, lmwork  # noqa: E402


class FakeData:
    def __init__(self, sft):
        self._m = {"shards": 400, "sft": sft}

    def meta(self):
        return self._m

    @property
    def n_shards(self):
        return 400


class FakeSB:
    def __init__(self):
        self.jobs = None

    def get(self, q):
        return []

    def rpc(self, fn, body):
        self.jobs = body["p_jobs"]
        return len(body["p_jobs"])


def _round(sft, n_kd=107):
    w = object.__new__(lmwork.LMWorker)
    w.sb, w.data, w.stats, w.log = FakeSB(), FakeData(sft), {"lm_rounds": 0}, lambda *_: None
    w.node = type("N", (), {"id": "n"})()
    w.kd_files = lambda: {s: {"name": f"kd-{s:04d}.bin.gz", "sha256": "0" * 64} for s in range(n_kd)}

    async def latest():
        return {"version": 1}

    w.latest = latest
    asyncio.run(w.coordinate())
    return w.sb.jobs


def test_round_mix_kd_half_and_sft():
    jobs = _round([{"name": "sft-logic-0001.bin.gz", "sha256": "a" * 64}])
    assert len(jobs) == lmwork.ROUND_JOBS
    kd = [j for j in jobs if "kd" in j["params"]]
    sft = [j for j in jobs if "sft" in j["params"]]
    assert len(sft) == 1 and len(kd) == round(0.5 * (lmwork.ROUND_JOBS - 1))
    assert all(j["params"]["kd"]["alpha"] == 0.15 and j["params"]["kd"]["T"] == 1.0 for j in kd)
    plain = [j for j in jobs if "kd" not in j["params"] and "sft" not in j["params"]]
    assert all(j["params"]["shard"] >= 107 for j in plain)  # bez destylacji = odłamki bez logitów nauczyciela
    assert lm.KD_ALPHA == 0.15 and lm.KD_T == 1.0


def test_round_without_sft_files():
    jobs = _round([])
    assert len(jobs) == lmwork.ROUND_JOBS and sum("kd" in j["params"] for j in jobs) == lmwork.ROUND_JOBS // 2


def test_sft_must_be_listed_in_meta():
    d = object.__new__(lmwork.Data)
    d._meta, d._meta_at = {"sft": [{"name": "sft-logic-0001.bin.gz", "sha256": "a" * 64}]}, 1e18
    with pytest.raises(ValueError):
        d.sft({"name": "inny.bin.gz", "sha256": "a" * 64})


def test_selfplay_shard_selection_balanced():
    p = Path(__file__).resolve().parents[1] / "scripts" / "export_selfplay_shard.py"
    sys.path.insert(0, str(p.parent))
    spec = importlib.util.spec_from_file_location("esp", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    rows = (
        [{"kind": "sprzeczność", "answer": "tak", "sha": f"s{i}"} for i in range(12)]
        + [{"kind": "aspekt", "answer": "nie", "sha": f"a{i}"} for i in range(7)]
        + [{"kind": "aspekt", "answer": "tak", "sha": f"b{i}"} for i in range(4)]
        + [{"kind": "porządek", "answer": "Adam", "sha": f"p{i}"} for i in range(5)]
        + [{"kind": "porządek", "answer": "Ewa", "sha": "p0"}]  # duplikat sha – odpada
    )
    out, rep = m.select(rows)
    assert rep["sprzeczność"]["kept"] == 0 and "dropped" in rep["sprzeczność"]
    assert rep["aspekt"]["answers"] == {"nie": 4, "tak": 4}
    assert rep["porządek"]["kept"] == 3
    assert len(out) == 11


def test_round_when_every_shard_has_teacher_logits():
    # 31.10.2026: logity nauczyciela dla wszystkich 399 odłamków → „Sample larger than population” i brak rund
    jobs = _round([{"name": "sft-logic-0001.bin.gz", "sha256": "a" * 64}, {"name": "sft-math-0001.bin.gz", "sha256": "b" * 64}], 399)
    assert len(jobs) == lmwork.ROUND_JOBS
    sft = sorted(j["params"]["sft"]["name"] for j in jobs if "sft" in j["params"])
    assert sft == ["sft-logic-0001.bin.gz", "sft-math-0001.bin.gz"]
    kd = [j for j in jobs if "kd" in j["params"]]
    assert len(kd) == round(lmwork.KD_FRAC * (lmwork.ROUND_JOBS - 2))
    plain = [j["params"]["shard"] for j in jobs if "kd" not in j["params"] and "sft" not in j["params"]]
    assert len(plain) == lmwork.ROUND_JOBS - 2 - len(kd) and not set(plain) & {j["params"]["shard"] for j in kd}
