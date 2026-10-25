"""Lokalny panel węzła: przydział mocy, harmonogram, dziennik, konto (bez sieci) i zabezpieczenia serwera."""

import json
import os
import stat
import urllib.error
import urllib.request

import pytest

from iot_mycelium.mesh import sched
from iot_mycelium.mesh.account import AccountError, NodeAccount, Store
from iot_mycelium.mesh.history import History, scrub


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_sanitize_clamps_and_keeps_known_kinds():
    base = sched.defaults(2, 0)
    a = sched.sanitize({"threads": 10_000, "cpu_pct": 1, "shares": {"lm_train": 250, "evil": 5}}, base)
    assert a["threads"] == (os.cpu_count() or 1)
    assert a["cpu_pct"] == 5
    assert a["shares"]["lm_train"] == 100 and "evil" not in a["shares"]
    assert sched.sanitize({"threads": "x"}, base)["threads"] == 2


def test_scheduler_cpu_budget_and_shares():
    c = Clock()
    a = sched.defaults(2, 0)
    a["cpu_pct"], a["shares"]["taxo"] = 50, 0
    s = sched.Scheduler(a, clock=c)
    assert not s.allowed("taxo")  # udział 0 = wyłączone
    assert s.allowed("lm_train")
    tok = s.start("lm_train")
    c.t += 301  # > 50% okna 600 s
    s.end(tok, label="lm_distill")
    assert not s.allowed("lm_train") and not s.allowed("lm_eval")
    c.t += 400  # okno się przesuwa
    assert s.allowed("lm_train")
    assert s.totals["lm_distill"]["n"] == 1
    a["cpu_pct"], a["shares"]["lm_eval"] = 100, 10
    with s.job("lm_eval"):
        c.t += 61
    assert not s.allowed("lm_eval") and s.allowed("lm_train")


def test_history_persists_filters_and_scrubs(tmp_path):
    h = History("t", tmp_path / "h.jsonl")
    h.add("job", "trening", ms=1200)
    h.add("log", "Bearer eyJabcdefghij.abcdef.ghijkl i MYC-ABCDEF-ABCDEF-ABCDEF-ABCDEF")
    rows = h.query()
    assert rows[0]["kind"] == "log" and "eyJ" not in rows[0]["msg"] and "MYC-" not in rows[0]["msg"]
    assert [r["kind"] for r in h.query(kind="job")] == ["job"]
    assert h.query(q="TRENING")[0]["ms"] == 1200
    assert h.daily()[0]["jobs"] == 1
    assert scrub('"refresh_token": "abcdefghijkl"').count("abcdefghijkl") == 0


def test_account_session_file_is_private_and_never_exposed(tmp_path):
    calls = []

    def post(path, body, token=None, timeout=20):
        calls.append((path, body, token))
        if path == "/auth/v1/signup":
            return {"access_token": "AT-secret", "refresh_token": "RT-secret", "expires_in": 3600}
        if path.endswith("myc_acct_create"):
            assert body["p_nodes"] == ["n1"] and token == "AT-secret"
            return {"handle": "ala", "nodes": ["n1"], "points": {"pending": 2}, "has_recovery": False}
        raise AssertionError(path)

    st = Store(tmp_path / "account.json", use_keyring=False)
    acc = NodeAccount("n1", store=st, post=post, log=lambda *a: None)
    with pytest.raises(AccountError):
        acc.create("x")  # za krótki pseudonim – bez wywołań sieci
    assert not calls
    v = acc.create("ala")
    assert v["logged_in"] and v["me"]["this_node_linked"] and v["me"]["points"] == {"pending": 2}
    assert "secret" not in json.dumps(v)
    if os.name != "nt":
        assert stat.S_IMODE((tmp_path / "account.json").stat().st_mode) == 0o600
    with pytest.raises(AccountError):
        acc.recover("zly-kod")


def _req(port, path, token=None, host=None, body=None, origin=None):
    h = {}
    if token:
        h["X-Myc-Token"] = token
    if host:
        h["Host"] = host
    if origin:
        h["Origin"] = origin
    if body is not None:
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=None if body is None else json.dumps(body).encode(), headers=h
    )
    try:
        with urllib.request.urlopen(r, timeout=5) as x:
            return x.status, json.loads(x.read() or b"null") if "json" in x.headers.get("Content-Type", "") else None
    except urllib.error.HTTPError as e:
        return e.code, None


def test_server_requires_token_host_and_origin(tmp_path, monkeypatch):
    monkeypatch.setenv("MYC_CACHE", str(tmp_path))
    from iot_mycelium.mesh.dashboard import Api, Panel, ui_token
    from iot_mycelium.mesh.status import serve_status
    from iot_mycelium.mesh.sysmon import Monitor

    acc = NodeAccount("n1", store=Store(tmp_path / "a.json", use_keyring=False), post=None, log=lambda *a: None)
    panel = Panel("t", "n1", sched.defaults(1, 0), History("t"), Monitor(), acc, log=lambda *a: None)
    tok = ui_token()
    if os.name != "nt":
        assert stat.S_IMODE((tmp_path / "ui-token").stat().st_mode) == 0o600
    api = Api(panel, tok)
    port = serve_status(lambda: {"connected": False}, 18765, api)
    assert _req(port, "/status.json")[0] == 200  # publiczny stan (jak dotąd, test startu w CI)
    assert _req(port, "/api/state")[0] == 401
    assert _req(port, "/api/state", token="zly")[0] == 401
    assert _req(port, "/api/state", token=tok, host="evil.example")[0] == 403
    code, st = _req(port, "/api/state", token=tok)
    assert code == 200 and st["phase"] and st["alloc"]["threads"] == 1
    assert _req(port, "/api/alloc", token=tok, body={"cpu_pct": 40}, origin="http://evil.example")[0] == 403
    code, r = _req(port, "/api/alloc", token=tok, body={"cpu_pct": 40, "gpu_on": True})
    assert code == 200 and r["alloc"]["cpu_pct"] == 40
    assert r["alloc"]["gpu_on"] is panel.caps["torch_cuda"]  # bez CUDA nie da się włączyć GPU
    assert json.loads((tmp_path / "alloc-t.json").read_text())["cpu_pct"] == 40
    panel.monitor.sample()
    code, st = _req(port, "/api/state", token=tok)
    assert st["samples"] and st["samples"][-1]["cpu_proc"] >= 0
