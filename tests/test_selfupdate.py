from iot_mycelium.mesh import selfupdate as su

TAG = "node-20261024-1917-d47ce80"


def manifest(**kw):
    m = {
        "tag": TAG,
        "files": [
            {"os": o, "name": f"bin-{o}", "url": f"{su.RELEASE_PREFIX}{TAG}/bin-{o}", "sha256": "a" * 64}
            for o in ("windows", "linux", "macos")
        ],
        "smoke": {"windows": "ok (22 s)", "linux": "ok (20 s)", "macos": "ok (10 s)"},
    }
    m.update(kw)
    return m


def test_gate_every_stage_no_worse_one_better():
    assert su.gate_ok(None)
    assert su.gate_ok({"lm": {"prev": 712, "new": 714}, "ppl": {"prev": 32.8, "new": 32.8, "higher": False}})
    assert not su.gate_ok({"lm": {"prev": 712, "new": 712}})  # nic lepszego
    assert not su.gate_ok({"lm": {"prev": 712, "new": 900}, "ppl": {"prev": 30, "new": 31, "higher": False}})


def test_plan_rules():
    assert su.plan(manifest(), "b" * 64, set())[1] == "ok"
    assert su.plan(manifest(), "a" * 64, set())[0] is None  # aktualna
    assert su.plan(manifest(), "b" * 64, {TAG})[0] is None  # zablokowane po nieudanym starcie
    assert su.plan(manifest(smoke={"linux": "fail"}), "b" * 64, set())[0] is None
    assert su.plan(manifest(gate={"lm": {"prev": 712, "new": 700}}), "b" * 64, set())[0] is None
    bad = manifest()
    for f in bad["files"]:
        f["url"] = "https://example.com/x"
    assert su.plan(bad, "b" * 64, set())[0] is None


def test_sums_and_signature_fail_closed():
    s = f"{'c' * 64}  bin-linux\n{'d' * 64}  MyceliumNode.exe\n"
    assert su.sums_lookup(s, "MyceliumNode.exe") == "d" * 64 and su.sums_lookup(s, "x") is None
    assert su.verify_signature(b"x", b"{}") is False  # brak biblioteki albo zły podpis → brak aktualizacji


def test_swap_and_rollback(tmp_path):
    exe, new = tmp_path / "MyceliumNode", tmp_path / "MyceliumNode.new"
    exe.write_bytes(b"old")
    new.write_bytes(b"new")
    old = su.swap(exe, new)
    assert exe.read_bytes() == b"new" and old.read_bytes() == b"old" and not new.exists()
    su.rollback(exe, old)
    assert exe.read_bytes() == b"old" and not old.exists()


def test_disabled_outside_binary(monkeypatch):
    assert not su.enabled({})  # testy nie są exe
    monkeypatch.setattr(su.sys, "frozen", True, raising=False)
    assert su.enabled({})
    assert not su.enabled({"no_self_update": True})
    monkeypatch.setenv("MYC_NO_SELF_UPDATE", "1")
    assert not su.enabled({})
