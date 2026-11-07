"""Wykrywanie blokady planu Supabase (HTTP 402 / egress) – dłuższy oddech zamiast młócenia API."""

from __future__ import annotations

from iot_mycelium.mesh.net import QUOTA_BACKOFF_S, is_quota_block


def test_quota_block_detects_egress_message():
    msg = (
        "HTTP 402 https://example/rpc/myc_claim: "
        '{"message":"Service for this project is restricted due to the following violations: '
        "exceed_cached_egress_quota, exceed_egress_quota. The project owner must upgrade their plan "
        'or remove spend caps to restore service."}'
    )
    assert is_quota_block(msg)
    assert is_quota_block(RuntimeError(msg))
    assert is_quota_block("InvalidStatus: server rejected WebSocket connection: HTTP 402")


def test_quota_block_ignores_ordinary_errors():
    assert not is_quota_block("HTTP 500 internal")
    assert not is_quota_block("HTTP 401 unauthorized")
    assert not is_quota_block(TimeoutError("timed out"))
    assert not is_quota_block("DeadConnection: brak odpowiedzi serwera od 30 s")


def test_quota_backoff_default_is_half_hour():
    assert QUOTA_BACKOFF_S >= 1800
