"""Puzzle #71: poprawność hash160 na rozwiązanych zagadkach, zgodność C i Pythona, szyfrowanie trafienia, zgoda."""

from __future__ import annotations

import json

import pytest

from iot_mycelium.mesh import sched
from iot_mycelium.mesh.p71 import RANGE_LO, TARGET_ADDRESS, TARGET_H160, core

# Publiczna lista rozwiązanych zagadek (klucz prywatny, adres) – https://privatekeys.pw/puzzles/bitcoin-puzzle-tx
SOLVED = {
    20: (0xD2C55, "1HsMJxNiV7TLxmoF6uJNkydxPFDog4NQum"),
    21: (0x1BA534, "14oFNXucftsHiUMY8uctg6N487riuyXs4h"),
    22: (0x2DE40F, "1CfZWK1QTQE3eS9qn61dQjV89KDjZzfNcv"),
    23: (0x556E52, "1L2GM8eE7mJWLdo3HZS6su1832NX2txaac"),
    24: (0xDC2A04, "1rSnXMr63jdCuegJFuidJqWxUPV7AtUf7"),
    25: (0x1FA5EE5, "15JhYXn6Mx3oF4Y7PcTAv2wVVAuCFFQNiP"),
    26: (0x340326E, "1JVnST957hGztonaWK6FougdtjxzHzRMMg"),
    27: (0x6AC3875, "128z5d7nN7PkCuX5qoA4Ys6pmxUYnEy86k"),
    28: (0xD916CE8, "12jbtzBb54r97TCwW3G1gCFoumpckRAPdY"),
    29: (0x17E2551E, "19EEC52krRUK1RkUAEZmQdjTyHT7Gp1TYT"),
    30: (0x3D94CD64, "1LHtnpd8nU5VHEMkG2TMYYNUjjLc992bps"),
}


def test_target_address_decodes():
    assert core.address_h160(TARGET_ADDRESS).hex() == TARGET_H160
    assert core.h160_address(bytes.fromhex(TARGET_H160)) == TARGET_ADDRESS
    with pytest.raises(ValueError):
        core.address_h160(TARGET_ADDRESS[:-1] + "V")


@pytest.mark.parametrize("n", sorted(SOLVED))
def test_solved_puzzles_python(n):
    k, addr = SOLVED[n]
    assert k.bit_length() == n  # zagadka n ma klucz w zakresie 2^(n-1)..2^n-1
    assert core.address_of_key(k) == addr


def test_ripemd_fallback_matches():
    for m in (b"", b"abc", bytes(32), bytes(range(70))):
        assert core._rmd160_py(m) == core.rmd160(m)


def test_scan_py_finds_key_and_xor_matches_naive():
    k, addr = SOLVED[24]
    t = core.address_h160(addr)
    hit, xo = core.scan_py(k - 1500, 3000, t)  # przez granicę paczki (BATCH = 1024)
    assert hit == k
    acc = 0
    for kk in range(k - 1500, k + 1500):
        acc ^= int.from_bytes(core.h160_of_key(kk), "big")
    assert xo == acc.to_bytes(20, "big")
    assert core.scan_py(k + 1, 2000, t)[0] is None


@pytest.fixture(scope="module")
def cc(tmp_path_factory):
    p = core.build(tmp_path_factory.mktemp("p71") / "p71core.so")
    if p is None:
        pytest.skip("brak kompilatora C")
    return core.CCore(p)


def test_c_matches_solved_and_python(cc):
    for k, addr in SOLVED.values():
        assert cc.h160_of_key(k) == core.address_h160(addr)
    k, addr = SOLVED[27]
    t = core.address_h160(addr)
    for start, n in ((k - 1024, 2049), (k - 5, 6), (k, 1), (k + 1, 3000)):
        assert cc.scan(start, n, t) == core.scan_py(start, n, t)
    # zakres #71: te same wyniki obu ścieżek na początku przestrzeni
    assert cc.scan(RANGE_LO, 2500, t) == core.scan_py(RANGE_LO, 2500, t)


def test_c_rejects_bad_start(cc):
    with pytest.raises(ValueError):
        cc.scan(5, 10, bytes(20))


def test_seal_roundtrip_and_no_plaintext():
    pytest.importorskip("cryptography")
    from cryptography.hazmat.primitives import serialization as s
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    from iot_mycelium.mesh.p71 import seal

    priv = X25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(s.Encoding.Raw, s.PublicFormat.Raw)
    payload = {"key_hex": f"{SOLVED[30][0]:064x}", "puzzle": 71}
    ct = seal.seal(payload, pub)
    assert payload["key_hex"] not in ct and "3d94cd64" not in ct
    raw = priv.private_bytes(s.Encoding.Raw, s.PrivateFormat.Raw, s.NoEncryption())
    assert seal.open_sealed(ct, raw) == payload
    other = X25519PrivateKey.generate().private_bytes(s.Encoding.Raw, s.PrivateFormat.Raw, s.NoEncryption())
    with pytest.raises(Exception):  # noqa: B017 – zły klucz = InvalidTag
        seal.open_sealed(ct, other)
    assert len(seal.owner_pub()) == 32


def test_consent_default_off_and_capped():
    base = sched.defaults(4, 3.0)
    assert base["p71"] == {"on": False, "pct": 10}
    a = sched.sanitize({"p71": {"on": True, "pct": 80}}, base)
    assert a["p71"] == {"on": True, "pct": 10}
    assert sched.sanitize({}, base)["p71"]["on"] is False


class FakeNode:
    id = "0d22e939-0000-4000-8000-000000000001"


class FakeKey:
    pub = "ab" * 32

    def sign(self, msg: bytes) -> str:
        return "cd" * 64


class FakeSB:
    def __init__(self):
        self.calls = []

    def rpc(self, fn, args):
        self.calls.append((fn, args))
        return {"ok": True}


def test_worker_hit_is_sealed_never_logged(tmp_path, monkeypatch):
    pytest.importorskip("cryptography")
    from iot_mycelium.mesh.p71 import worker as w

    k, addr = SOLVED[25]
    logs: list[str] = []
    sb = FakeSB()
    wk = w.P71Worker(FakeNode(), pct=10, threads=4, log=logs.append, sb=sb, key=FakeKey(), state_dir=tmp_path)
    assert abs(wk.duty - 0.4) < 1e-9
    wk.target = core.address_h160(addr)
    wk.cc = None  # ścieżka Pythona (szybki test)
    monkeypatch.setattr(w, "chunk_start", lambda idx: k - 700)
    r = wk.run_chunk({"idx": 7, "mode": "scan", "n": 2000})
    assert r == {"ok": True}
    fns = [c[0] for c in sb.calls]
    assert "myc_p71_hit" in fns and fns[-1] == "myc_p71_done"
    hexkey = f"{k:064x}"
    dumped = json.dumps(sb.calls) + "\n".join(logs)
    assert hexkey not in dumped and f"{k:x}" not in dumped and str(k) not in dumped
    files = list((tmp_path / "p71").glob("hit-*.sealed"))
    assert len(files) == 1 and (files[0].stat().st_mode & 0o777) == 0o600
    assert hexkey not in files[0].read_text()
    done = sb.calls[-1][1]
    assert done["p_keys"] == 2000 and len(done["p_xor"]) == 40


def test_worker_resumes_from_local_state(tmp_path, monkeypatch):
    from iot_mycelium.mesh.p71 import worker as w

    sb = FakeSB()
    wk = w.P71Worker(FakeNode(), pct=10, threads=1, log=lambda *_: None, sb=sb, key=FakeKey(), state_dir=tmp_path)
    wk.cc = None
    monkeypatch.setattr(w, "chunk_start", lambda idx: RANGE_LO)
    monkeypatch.setattr(w, "SLICE", 1024)
    full = core.scan_py(RANGE_LO, 3072, wk.target)[1].hex()
    part = core.scan_py(RANGE_LO, 1024, wk.target)[1].hex()
    wk._save_state({"idx": 3, "mode": "scan", "off": 1024, "xor": part, "ms": 10})
    wk.duty = 1.0
    wk.run_chunk({"idx": 3, "mode": "scan", "n": 3072})
    assert sb.calls[-1][1]["p_xor"] == full
