"""Telemetria „Moc”: średnie z próbek, praca wg rodzaju z różnic sched.totals, brak GPU = null."""

from iot_mycelium.mesh.moc import Reporter


class SB:
    def __init__(self):
        self.calls = []

    def rpc(self, fn, body):
        self.calls.append((fn, body))
        return {"ok": True}


def test_build_averages_and_work_deltas():
    r = Reporter("n", SB(), every=0)
    r.build({"lm_train": {"s": 10.0}}, 3, "cpu")  # punkt odniesienia
    for c in (50, 70):
        r.add({"cpu": c, "cpu_proc": c / 2, "ram_total": 100, "ram_used": 40, "ram_proc": 2**30})
    d = r.build({"lm_train": {"s": 40.0}, "lm_aggregate": {"s": 5.0}, "inne": {"s": 9}}, 3, "cpu")
    assert d["cpu"] == 60 and d["cpu_max"] == 70 and d["cpu_proc"] == 30 and d["mem"] == 40 and d["rss_mb"] == 1024
    assert d["gpu"] is None and d["threads"] == 3 and d["device"] == "cpu"
    assert d["work"]["lm_train"] == 30 and "inne" not in d["work"]


def test_unknown_device_is_reported_as_cpu_and_post_uses_rpc():
    sb = SB()
    r = Reporter("n", sb, every=0)
    r.add({"cpu": 1})
    d = r.build({}, 2, "webgpu?")
    assert d["device"] == "cpu" and r.post(d) and sb.calls[0][0] == "myc_moc_push"
