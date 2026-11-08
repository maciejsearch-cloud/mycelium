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


def test_quota_block_detects_urllib_http_error():
    from io import BytesIO
    from urllib.error import HTTPError

    err = HTTPError("https://example/rest/v1/rpc/x", 402, "Payment Required", hdrs=None, fp=BytesIO(b""))
    assert is_quota_block(err)
    assert is_quota_block("HTTP Error 402: Payment Required")
    other = HTTPError("https://example", 401, "Unauthorized", hdrs=None, fp=BytesIO(b""))
    assert not is_quota_block(other)


def test_js_quota_helper_mirrors_python():
    import subprocess
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    helper = (root / "web/scripts/shared/quota.mjs").resolve().as_uri()
    script = f"""
    import {{ isQuotaBlock, nextPollDelayMs }} from '{helper}'
    const msg = 'myc_rozmowa_pending: 402 {{"message":"exceed_egress_quota"}}'
    if (!isQuotaBlock(msg)) process.exit(1)
    if (!isQuotaBlock('HTTP Error 402: Payment Required')) process.exit(2)
    if (isQuotaBlock('HTTP 500 internal')) process.exit(3)
    if (isQuotaBlock('HTTP 401 unauthorized')) process.exit(4)
    if (nextPollDelayMs(msg, 2000) < 1_800_000) process.exit(5)
    if (nextPollDelayMs('timeout', 2000) !== 4000) process.exit(6)
    if (nextPollDelayMs('timeout', 40000) !== 60000) process.exit(7)
    """
    r = subprocess.run(["node", "--input-type=module", "-e", script], check=False, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr or r.stdout
