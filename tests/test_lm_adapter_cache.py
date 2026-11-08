"""Pamięć podręczna adapterów LoRA na dysku (mniej egressu Supabase)."""

from __future__ import annotations

import pytest

from iot_mycelium.mesh import lm
from iot_mycelium.mesh.lmwork import adapter_bytes

BODY = b"prawdziwe bajty adaptera w tescie"
PATH = f"lm/v7-{lm.sha256(BODY)[:8]}.bin"


def test_pobiera_raz_potem_z_dysku(tmp_path):
    calls = []

    def fetch(p):
        calls.append(p)
        return BODY

    assert adapter_bytes(PATH, fetch, tmp_path) == BODY
    assert adapter_bytes(PATH, fetch, tmp_path) == BODY
    assert calls == [PATH]


def test_uszkodzony_plik_na_dysku_pobierany_ponownie(tmp_path):
    (tmp_path / PATH.split("/", 1)[1]).write_bytes(b"zepsute")
    assert adapter_bytes(PATH, lambda p: BODY, tmp_path) == BODY
    assert (tmp_path / PATH.split("/", 1)[1]).read_bytes() == BODY


def test_zla_suma_z_sieci_odrzucona_i_nie_zapisana(tmp_path):
    with pytest.raises(ValueError):
        adapter_bytes(PATH, lambda p: b"inne", tmp_path)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("bad", ["../x.bin", "lm/../../etc", "lm/v1-zz.bin", "har/v1-0123abcd.bin"])
def test_niedozwolone_sciezki(tmp_path, bad):
    with pytest.raises(ValueError):
        adapter_bytes(bad, lambda p: BODY, tmp_path)
