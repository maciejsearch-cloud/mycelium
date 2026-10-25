"""Model językowy grzybni: format adaptera i danych, stały zbiór testowy, autostart węzła (bez wag modelu)."""

import gzip
import hashlib
import json
import re
from pathlib import Path

import torch

from iot_mycelium.mesh import lm

ROOT = Path(__file__).resolve().parents[1]
LM = ROOT / "web" / "public" / "data" / "lm"


def test_adapter_roundtrip_and_size():
    a = lm.Lora.init(seed=0)
    assert float(a.b_qkv.abs().sum()) == 0 and float(a.b_o.abs().sum()) == 0  # v0 = model bazowy
    a.b_qkv.normal_(0, 0.01)
    b = a.to_bytes({"version": 1})
    assert len(b) < 800_000  # < limit kubełka i ok. 1 MB w base64 (limit myc_results.payload dla lm)
    r = lm.Lora.from_bytes(b)
    assert sum(t.numel() for t in r.tensors()) == lm.N_PARAMS == 368_640
    assert torch.allclose(r.b_qkv, a.b_qkv, atol=1e-4)
    assert lm.Lora.init(seed=0).a_qkv.equal(lm.Lora.init(seed=0).a_qkv)  # ten sam start na każdym węźle


def test_average_weighted():
    x, y = lm.Lora.init(), lm.Lora.init()
    x.b_o.fill_(1.0)
    y.b_o.fill_(4.0)
    assert torch.allclose(lm.Lora.average([(x, 2), (y, 1)]).b_o, torch.full_like(x.b_o, 2.0))


def test_data_pack_roundtrip():
    ids = torch.arange(12, dtype=torch.int32).view(3, 4)
    mask = torch.tensor([[0, 1, 1, 1]] * 3, dtype=torch.uint8)
    meta, i2, m2, extra = lm.unpack_data(lm.pack_data({"kind": "t"}, ids, mask, b"[1]"))
    assert meta["n"] == 3 and meta["t"] == 4 and i2.equal(ids.long()) and m2.equal(mask.bool()) and extra == b"[1]"


def test_eval_set_fixed_and_registered():
    meta = json.loads((LM / "meta.json").read_text())
    eb = (LM / "eval.bin").read_bytes()
    assert hashlib.sha256(eb).hexdigest() == meta["eval"]["sha256"]
    sql = (ROOT / "supabase" / "myc_lm.sql").read_text()
    m = re.search(r"myc_eval_sets \(model, n, sha, version\) values \('lm', (\d+), '([0-9a-f]{64})', (\d+)\)", sql)
    assert m and int(m.group(1)) == meta["eval"]["n_mc"] == 2000 and m.group(2) == meta["eval"]["sha256"]
    assert int(m.group(3)) == meta["eval"]["version"]
    em, ids, mask, extra = lm.unpack_data(eb)
    mc = json.loads(extra)
    assert len(mc) == em["n_mc"] and all(len(o) == 4 and 0 <= a < 4 for o, a in mc)
    assert ids.shape[0] == em["n_ppl"] + 4 * em["n_mc"]
    # odpowiedzi poprawne rozłożone na pozycje (brak prostego wzorca)
    assert len({a for _, a in mc}) == 4


def test_train_shards_checksums_and_no_eval_leak():
    meta = json.loads((LM / "meta.json").read_text())
    assert meta["shards"] == len(meta["files"]) >= 100
    f = meta["files"][0]
    b = (LM / f["name"]).read_bytes()
    assert hashlib.sha256(b).hexdigest() == f["sha256"]
    _, ids, mask, _ = lm.unpack_data(gzip.decompress(b))
    assert ids.shape == (meta["seq_per_shard"], meta["t_train"]) and mask.any()
    _, eids, _, _ = lm.unpack_data((LM / "eval.bin").read_bytes())
    # żaden akapit testowy nie występuje w odłamku treningowym (podział po haśle)
    train_rows = {tuple(r[:32].tolist()) for r in ids}
    assert not any(tuple(r[:32].tolist()) in train_rows for r in eids[: meta["eval"]["n_ppl"]])


def test_service_args(tmp_path, monkeypatch):
    monkeypatch.setenv("MYC_CACHE", str(tmp_path))
    from iot_mycelium.mesh import service

    c = service.default_cfg()
    a = service.node_args({**c, "threads": 3, "max_ram_gb": 3, "no_train": True})
    assert a[:2] == ["--join", "--name"] and "--threads" in a and "--no-train" in a and "--max-ram-gb" in a
    service.save_cfg(c)
    assert service.load_cfg() == c


def test_micro_batch_same_loss():
    """Mikro-paczki (mniej RAM) liczą tę samą stratę co cała paczka."""
    import torch

    from iot_mycelium.mesh import lm

    class M:  # minimalny model: sprawdzamy tylko podział paczki
        pass

    ids = torch.randint(0, 10, (8, 6))
    mask = torch.ones(8, 6, dtype=torch.bool)
    seen = []

    def fake_nll(m, lora, i, k, kd=None):
        seen.append(i.shape[0])
        return (lora.tensors()[0].sum() * 0 + i[:, 1:].float()).flatten()

    orig = lm.token_nll
    lm.token_nll = fake_nll
    try:
        full = lm.Trainer(M(), lm.Lora.init(), ids, mask, 8, 1e-3, 1).step()
        part = lm.Trainer(M(), lm.Lora.init(), ids, mask, 8, 1e-3, 1, micro=2).step()
    finally:
        lm.token_nll = orig
    assert abs(full - part) < 1e-5 and seen == [8, 2, 2, 2, 2]


def test_kd_pack_roundtrip_and_offsets():
    idx = torch.randint(0, 151936, (5, 32), dtype=torch.int32)
    lg = torch.randn(5, 32).half()
    meta, i2, l2 = lm.unpack_kd(lm.pack_kd({"shard": 3}, idx, lg))
    assert meta["shard"] == 3 and meta["p"] == 5 and i2.equal(idx.long()) and l2.equal(lg.float())
    mask = torch.tensor([[0, 1, 1, 0], [0, 0, 1, 1]], dtype=torch.uint8).bool()
    assert lm.kd_offsets(mask).tolist() == [0, 2, 4]


def test_kd_loss_properties():
    torch.manual_seed(0)
    emb = torch.randn(50, 8)
    x, y = torch.randn(6, 8), torch.randint(0, 50, (6,))
    ce = lm._ce(x, y, emb)
    z = x @ emb.t()
    ti = torch.arange(50).expand(6, 50).contiguous()
    # α = 0 → czysta entropia krzyżowa
    assert torch.allclose(lm._ce_kd(x, y, emb, ti, z, 2.0, 0.0), ce, atol=1e-5)
    # nauczyciel = uczeń (pełny słownik) → KL = 0
    assert torch.allclose(lm._ce_kd(x, y, emb, ti, z, 2.0, 1.0), torch.zeros(6), atol=1e-5)
    # inny nauczyciel → KL > 0
    assert (lm._ce_kd(x, y, emb, ti, torch.randn(6, 50) * 3, 2.0, 1.0) > 0).all()


def test_nonfinite_step_skipped(monkeypatch):
    """Krok z NaN w stracie nie zmienia adaptera (pomijany i liczony)."""
    base = lm.Lora.init(seed=0)
    ids = torch.zeros(4, 6, dtype=torch.long)
    mask = torch.ones(4, 6, dtype=torch.bool)

    def nan_nll(m, lora, i, k, kd=None):
        return (lora.a_qkv.sum() * float("nan")).expand(int(k[:, 1:].sum()))

    monkeypatch.setattr(lm, "token_nll", nan_nll)
    tr = lm.Trainer(None, base, ids, mask, batch=2, lr=1e-2, seed=0)
    tr.step()
    out, st = tr.result()
    assert st["skipped"] == 1 and out.a_qkv.equal(base.a_qkv)


def test_lora_finite_check():
    a = lm.Lora.init(seed=0)
    assert a.finite()
    a.b_o[0, 0, 0] = float("nan")
    assert not a.finite()
