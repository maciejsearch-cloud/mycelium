"""Węzeł bez przeglądarki: format ramek zgodny z web/src/mesh/net.ts i podział słownika jak w qwen.ts."""

import struct

from iot_mycelium.mesh.net import pack, unpack
from iot_mycelium.mesh.node import SHARDS, emb_range
from iot_mycelium.mesh.qwen import VOCAB


def test_pack_roundtrip():
    m, b = unpack(pack({"k": "req", "rid": "7", "ids": [1, 2]}, b"\x01\x02"))
    assert m == {"k": "req", "rid": "7", "ids": [1, 2]}
    assert b == b"\x01\x02"
    # nagłówek: długość JSON jako uint32 little-endian (jak DataView.setUint32(..., true))
    u = pack({"a": 1})
    assert struct.unpack_from("<I", u)[0] == len(u) - 4


def test_shards_and_vocab_split():
    assert [f"L{i}" for i in range(8)] + [f"E{i}" for i in range(4)] == SHARDS
    parts = [emb_range(i) for i in range(4)]
    assert parts[0][0] == 0 and parts[-1][1] == VOCAB
    assert all(parts[i][1] == parts[i + 1][0] for i in range(3))


def test_recv_or_dead_detects_silent_socket():
    import asyncio

    import pytest

    from iot_mycelium.mesh.net import DeadConnection, recv_or_dead

    class Silent:
        async def recv(self):
            await asyncio.sleep(3600)

    class Talky:
        async def recv(self):
            return '{"event":"phx_reply"}'

    with pytest.raises(DeadConnection):
        asyncio.run(recv_or_dead(Silent(), 0.05))
    assert asyncio.run(recv_or_dead(Talky(), 0.05)) == '{"event":"phx_reply"}'


def test_untrusted_frames_are_bounded():
    """Publiczny pokój: ramki z absurdalnym `tot`, złym indeksem lub nadmiarem niedokończonych wiadomości są odrzucane."""
    import asyncio

    from iot_mycelium.mesh import net as netmod

    got = []

    async def on_msg(frm, m, b):
        got.append((frm, m, b))

    n = netmod.Net("me", {}, on_msg)

    async def run():
        await n._recv_frame("x", struct.pack("<IHH", 1, 0, 60000) + b"a")  # tot > MAX_FRAMES
        await n._recv_frame("x", struct.pack("<IHH", 2, 5, 3) + b"a")  # idx >= tot
        for i in range(netmod.MAX_PENDING + 10):
            await n._recv_frame(f"p{i}", struct.pack("<IHH", 3, 0, 2) + b"a")
        assert len(n.parts) == netmod.MAX_PENDING
        u = pack({"k": "req", "rid": "1"})
        n.parts.clear()
        await n._recv_frame("ok", struct.pack("<IHH", 9, 0, 1) + u)
        await asyncio.sleep(0)

    asyncio.run(run())
    assert got == [("ok", {"k": "req", "rid": "1"}, None)]


def test_token_ids_validated():
    import pytest

    from iot_mycelium.mesh.node import MAX_CTX, _check_ids

    _check_ids([1, 2, 3])
    for bad in ([], [-1], [VOCAB], ["1"], [1.5], list(range(MAX_CTX + 1)), "abc", None):
        with pytest.raises(ValueError):
            _check_ids(bad)


def test_data_file_names_cannot_escape_cache(tmp_path, monkeypatch):
    import pytest

    monkeypatch.setenv("MYC_CACHE", str(tmp_path))
    from iot_mycelium.mesh.lmwork import Data

    d = Data(base=str(tmp_path))
    for bad in ("../x", "/etc/passwd", "a/../../b", "..", ".hidden"):
        with pytest.raises(ValueError):
            d.file(bad, "0" * 64)


def test_gen_same_rid_new_prompt_is_not_replayed():
    """Klient po przeładowaniu liczył rid od 1 przy trwałym id węzła: węzeł odtwarzał starą odpowiedź na nowe pytanie.
    Ponowienie (ta sama treść) dostaje zapisany stan, inna treść pod tym samym kluczem liczy się od nowa."""
    import asyncio

    from iot_mycelium.mesh.node import Node

    class FakeModel:
        def generate(self, conv, ids, max_new, temp, on_token, stop):
            for t in ids[-2:]:
                on_token(t)
            return {"tokens": ids[-2:], "tps": 1.0, "first_ms": 1.0, "reused": 0, "prompt": len(ids)}

    n = Node.__new__(Node)
    n.m, n.id, n.log = FakeModel(), "node", lambda *_: None
    n.stats = {"chats": 0, "tokens": 0, "last": None, "tps": None, "first_ms": None}
    n.lock, n.stops, n.gens = asyncio.Lock(), set(), {}
    sent: list[dict] = []

    class FakeNet:
        state = {"cap": 1}

        async def send(self, to, m, b=None):
            sent.append(m)

    n.net = FakeNet()

    def answer(ids):
        sent.clear()
        asyncio.run(n.on_msg("client", {"k": "req", "rid": "1", "op": "gen", "conv": "c", "ids": ids}, None))
        toks = [m for m in sent if m.get("k") == "tok"]
        return toks[-1]["ids"]

    assert answer([1, 2, 3]) == [2, 3]
    assert answer([1, 2, 3]) == [2, 3]  # ponowienie: zapisany stan
    assert answer([1, 7, 8]) == [7, 8]  # nowe pytanie z tym samym rid: nowa odpowiedź, nie stara
