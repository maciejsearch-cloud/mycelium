import json
import struct

import pytest

torch = pytest.importorskip("torch")

from iot_mycelium.mesh import qwen, qwen_int8  # noqa: E402


def _write_bf16(path, tensors):
    """Mały plik safetensors bf16 o układzie jak u Qwen (te same nazwy tensorów)."""
    from iot_mycelium.mesh.lm import tobytes

    h, off, blobs = {}, 0, []
    for k in sorted(tensors):
        b = tobytes(tensors[k].to(torch.bfloat16).contiguous())
        h[k] = {"dtype": "BF16", "shape": list(tensors[k].shape), "data_offsets": [off, off + len(b)]}
        off += len(b)
        blobs.append(b)
    hb = json.dumps(h).encode()
    hb += b" " * ((8 - len(hb) % 8) % 8)
    path.write_bytes(struct.pack("<Q", len(hb)) + hb + b"".join(blobs))


def test_quant_rows_matches_browser_rounding():
    w = torch.tensor([[127.0, 0.5, -0.5, 1.5], [0.0, 0.0, 0.0, 0.0]])
    q, s = qwen_int8.quant_rows(w)
    # Math.round: połówki w górę (0,5 → 1, −0,5 → 0, 1,5 → 2); wiersz zerowy: skala 1
    assert q.tolist() == [[127, 1, 0, 2], [0, 0, 0, 0]] and s.tolist() == [1.0, 1.0]


def test_convert_roundtrip_and_layout(tmp_path):
    g = torch.Generator().manual_seed(0)
    t = {
        "model.embed_tokens.weight": torch.randn(16, 8, generator=g),
        "model.layers.0.mlp.gate_proj.weight": torch.randn(12, 8, generator=g),
        "model.layers.0.self_attn.q_proj.weight": torch.randn(8, 8, generator=g),
        "model.layers.0.self_attn.q_proj.bias": torch.randn(8, generator=g),
        "model.norm.weight": torch.ones(8),
    }
    src, dst = tmp_path / "a.safetensors", tmp_path / "b.safetensors"
    _write_bf16(src, t)
    sha = qwen_int8.convert(src, dst, "0" * 64, log=lambda *_: None)
    assert sha == qwen_int8._sha_file(dst)
    assert qwen_int8.convert(src, tmp_path / "c.safetensors", "0" * 64, log=lambda *_: None) == sha  # deterministyczny
    assert qwen.weights_variant(dst) == "int8" and qwen.weights_variant(src) == "bf16"
    a, b = qwen.load_safetensors(src), qwen.load_safetensors(dst)
    assert set(a) == set(b)
    # uwaga/normy/biasy bez zmian (bf16), macierze int8 z błędem ≤ pół kroku kwantyzacji na wiersz
    for k in ("model.layers.0.self_attn.q_proj.weight", "model.layers.0.self_attn.q_proj.bias", "model.norm.weight"):
        assert torch.equal(a[k], b[k])
    for k in ("model.embed_tokens.weight", "model.layers.0.mlp.gate_proj.weight"):
        step = a[k].abs().amax(1, keepdim=True) / 127
        assert ((a[k] - b[k]).abs() <= step / 2 + 1e-6).all()
    h, _ = qwen_int8._header(dst)
    assert (
        h["model.embed_tokens.weight"]["dtype"] == "I8"
        and h["model.layers.0.self_attn.q_proj.weight"]["dtype"] == "BF16"
    )


def test_ensure_int8_falls_back_without_sha(tmp_path):
    msgs = []
    assert qwen_int8.ensure_int8(tmp_path, msgs.append, sha256="") is None
    assert "bf16" in msgs[0]


def test_ensure_int8_rejects_bad_checksum(tmp_path):
    f = tmp_path / "remote.bin"
    f.write_bytes(b"not the weights")
    msgs = []
    assert qwen_int8.ensure_int8(tmp_path / "c", msgs.append, url=f.as_uri(), sha256="1" * 64) is None
    assert any("SHA-256" in m for m in msgs) and not (tmp_path / "c" / qwen_int8.NAME).exists()


def test_ensure_int8_downloads_and_verifies(tmp_path):
    f = tmp_path / "remote.bin"
    f.write_bytes(b"weights" * 100)
    sha = qwen_int8._sha_file(f)
    p = qwen_int8.ensure_int8(tmp_path / "c", lambda *_: None, url=f.as_uri(), sha256=sha)
    assert p is not None and p.read_bytes() == f.read_bytes()
    assert qwen_int8.ensure_int8(tmp_path / "c", lambda *_: None, url="file:///nonexistent", sha256=sha) == p


def test_unknown_variant_rejected():
    with pytest.raises(ValueError):
        qwen.ensure_weights(variant="int4")
