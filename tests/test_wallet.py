"""Portfel MYC-test: podpisy Ed25519 (RFC 8032), łańcuch skrótów, Merkle, odrzucanie podwójnego wydania i powtórek."""

from __future__ import annotations

import os

import pytest

from iot_mycelium.mesh import ed25519
from iot_mycelium.mesh import walletwork as w

# RFC 8032, 7.1 TEST 1 i TEST 2
SK1 = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
PK1 = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
SIG1 = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
SK2 = bytes.fromhex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
PK2 = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"
SIG2 = "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"


@pytest.mark.parametrize("impl", ["python", "lib"])
def test_rfc8032_vectors(impl):
    pub, sign, verify = (
        (ed25519._py_public, ed25519._py_sign, ed25519._py_verify)
        if impl == "python"
        else (ed25519.public_key, ed25519.sign, ed25519.verify)
    )
    assert pub(SK1).hex() == PK1
    assert sign(SK1, b"").hex() == SIG1
    assert verify(bytes.fromhex(PK1), b"", bytes.fromhex(SIG1))
    assert pub(SK2).hex() == PK2
    assert sign(SK2, b"\x72").hex() == SIG2
    assert verify(bytes.fromhex(PK2), b"\x72", bytes.fromhex(SIG2))
    # zła wiadomość, zły klucz, zmieniony bit podpisu
    assert not verify(bytes.fromhex(PK1), b"x", bytes.fromhex(SIG1))
    assert not verify(bytes.fromhex(PK2), b"", bytes.fromhex(SIG1))
    bad = bytearray(bytes.fromhex(SIG1))
    bad[5] ^= 1
    assert not verify(bytes.fromhex(PK1), b"", bytes(bad))
    assert not verify(b"\x00" * 31, b"", bytes.fromhex(SIG1))


def _chain():
    a, c = os.urandom(32), os.urandom(32)
    pa, pc = ed25519.public_key(a).hex(), ed25519.public_key(c).hex()
    m = w.make_tx(w.ZERO, 1, "mint", pa, 1000, memo="faucet:" + "ab" * 16 + ":20261101")
    t = w.make_tx(m["hash"], 2, "transfer", pc, 300, seed=a, nonce=1, ts=1, memo="napiwek za odpowiedź")
    b = w.make_block(1, w.ZERO, [m, t], 123)
    st, n = w.verify_block(w.new_state(), b, [m, t])
    return a, c, pa, pc, b, st, n, t


def test_valid_block_and_balances():
    _, _, pa, pc, _, st, n, t = _chain()
    assert n == 1
    assert st["bal"] == {pa: 700, pc: 300}
    assert st["nonce"] == {pa: 1}
    assert st["last_hash"] == t["hash"]


def test_double_spend_and_replay_rejected():
    a, _, _, pc, b, st, _, t = _chain()
    replay = dict(t, id=3, prev_hash=t["hash"])
    replay["hash"] = w.tx_hash(t["hash"], replay)
    with pytest.raises(w.Invalid, match="nonce"):
        w.verify_block(st, w.make_block(2, b["hash"], [replay]), [replay])
    over = w.make_tx(t["hash"], 3, "transfer", pc, 701, seed=a, nonce=2, ts=2)
    with pytest.raises(w.Invalid, match="środków"):
        w.verify_block(st, w.make_block(2, b["hash"], [over]), [over])
    # dwa przelewy z tym samym nonce w jednym bloku (równoległe wysłanie)
    x1 = w.make_tx(t["hash"], 3, "transfer", pc, 600, seed=a, nonce=2, ts=2)
    x2 = w.make_tx(x1["hash"], 4, "transfer", pc, 600, seed=a, nonce=2, ts=3)
    with pytest.raises(w.Invalid):
        w.verify_block(st, w.make_block(2, b["hash"], [x1, x2]), [x1, x2])


def test_forged_signature_and_tamper_rejected():
    a, c, pa, pc, b, st, _, t = _chain()
    forged = w.make_tx(t["hash"], 3, "transfer", pc, 100, seed=c, nonce=1, ts=2)
    forged["from_pub"] = pa  # podpis kluczem c udający nadawcę a
    forged["hash"] = w.tx_hash(t["hash"], forged)
    with pytest.raises(w.Invalid, match="podpis"):
        w.verify_block(st, w.make_block(2, b["hash"], [forged]), [forged])
    ok = w.make_tx(t["hash"], 3, "transfer", pc, 100, seed=a, nonce=2, ts=2)
    blk = w.make_block(2, b["hash"], [ok])
    changed = dict(ok, amount=200)  # zmiana kwoty po podpisie
    with pytest.raises(w.Invalid):
        w.verify_block(st, blk, [changed])
    with pytest.raises(w.Invalid, match="poprzedniego"):
        w.verify_block(st, w.make_block(2, "f" * 64, [ok]), [ok])
    bad_root = dict(blk, merkle_root="0" * 64)
    with pytest.raises(w.Invalid, match="Merkle"):
        w.verify_block(st, bad_root, [ok])


def test_mint_rules():
    _, _, pa, _, b, st, _, t = _chain()
    big = w.make_tx(t["hash"], 3, "mint", pa, 5000, memo="faucet:" + "cd" * 16 + ":20261102")
    with pytest.raises(w.Invalid, match="regułami"):
        w.verify_block(st, w.make_block(2, b["hash"], [big]), [big])
    again = w.make_tx(t["hash"], 3, "mint", pa, 1000, memo="faucet:" + "ab" * 16 + ":20261101")
    with pytest.raises(w.Invalid, match="powtórzona"):
        w.verify_block(st, w.make_block(2, b["hash"], [again]), [again])


def test_merkle_odd_and_pow():
    hs = [w.sha(str(i)) for i in range(3)]
    assert w.merkle(hs) == w.merkle(hs + [hs[-1]])
    assert w.merkle(hs[:1]) == hs[0]
    n, tries = w.pow_solve("ab" * 32, "cd" * 32, 8)
    assert w.sha(f"{'ab' * 32}|{'cd' * 32}|{n}").startswith("00") and tries == n + 1


def test_selftest():
    assert w.selftest()["ok"]


class FakeSupa:
    """Odpowiedzi jak z PostgREST dla jednego bloku (bez sieci)."""

    def __init__(self, blocks, txs):
        self.blocks, self.txs, self.calls = blocks, txs, []

    def get(self, path):
        if path.startswith("myc_wallet_blocks"):
            return self.blocks
        if path.startswith("myc_wallet_attest"):
            return []
        if path.startswith("myc_wallet_tx"):
            return self.txs
        raise AssertionError(path)

    def rpc(self, fn, args):
        self.calls.append((fn, args))
        return {"finalized": 0}


def test_worker_attests_with_valid_signature(tmp_path):
    a = os.urandom(32)
    pa = ed25519.public_key(a).hex()
    m = w.make_tx(w.ZERO, 1, "mint", pa, 1000, memo="faucet:" + "ab" * 16 + ":20261101")
    b = dict(w.make_block(1, w.ZERO, [m]), final_at=None, pow_bits=8)
    node = type("N", (), {"id": "0d22e939-0000-4000-8000-000000000000"})()
    sb = FakeSupa([b], [m])
    ww = w.WalletWorker(node, log=lambda *x: None, sb=sb, key=w.NodeKey(node.id, tmp_path / "k"), state_dir=tmp_path)
    r = ww.step()
    assert r["blocks"] == 1 and r["attested"] == 1
    fn, args = sb.calls[-1]
    assert fn == "myc_wallet_attest" and args["p_ok"] is True
    msg = w.attest_msg(1, b["hash"], True, node.id, args["p_pow"])
    assert ed25519.verify(bytes.fromhex(ww.key.pub), msg, bytes.fromhex(args["p_sig"]))
    assert w.sha(f"{b['hash']}|{ww.key.pub}|{args['p_pow']}").startswith("00")
