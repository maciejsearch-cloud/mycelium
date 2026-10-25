from iot_mycelium.ai.history import append, load

RES = {
    "generated_at": "2026-10-17T20:21:44+00:00",
    "git": "abc",
    "mbs": 69.4,
    "mbs_linear": 60.0,
    "agents": [{"task": "har", "test": {"score": 0.91234}}],
}


def test_history_appends_real_runs_only_once(tmp_path):
    p = tmp_path / "h.jsonl"
    assert append(RES, p)
    assert not append(RES, p)  # duplikat
    assert not append({**RES, "generated_at": "x", "synthetic": True}, p)
    assert append({**RES, "generated_at": "2026-10-18T08:00:00+00:00", "mbs": 70.1}, p)
    rows = load(p)
    assert [r["mbs"] for r in rows] == [69.4, 70.1]
    assert rows[0]["scores"] == {"har": 0.9123}
