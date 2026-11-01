"""Moc – telemetria węzła do zakładki „Moc” (co minutę, uśrednione próbki monitora i czas zadań wg rodzaju).

Wysyłane tylko liczby: CPU całego komputera i procesu węzła (%), GPU (%, gdy system je podaje – inaczej null =
„brak danych GPU”), RAM (%), RAM procesu (MB), wątki, urządzenie ostatniego treningu, sekundy pracy wg rodzaju
zadania z planisty (sched.totals). Bez nazwy komputera, bez IP w danych (limit w bazie liczony jest po IP, ale IP
nie jest zapisywane w tabeli), bez nazw procesów.
"""

from __future__ import annotations

import time

EVERY = 60.0
WORK_KEYS = (
    "lm_train",
    "lm_distill",
    "lm_eval",
    "lm_aggregate",
    "rozbior",
    "taxo",
    "verify",
    "images",
    "wallet",
    "p71",
)


class Reporter:
    def __init__(self, node_id: str, sb, every: float = EVERY):
        self.node_id, self.sb, self.every = node_id, sb, every
        self.samples: list[dict] = []
        self.last_post = time.monotonic()
        self.last_totals: dict[str, float] | None = None
        self.errors = 0

    def add(self, s: dict):
        self.samples.append(s)

    def due(self) -> bool:
        return time.monotonic() - self.last_post >= self.every and bool(self.samples)

    def build(self, totals: dict, threads: int, device: str) -> dict:
        ss, self.samples = self.samples, []
        iv = time.monotonic() - self.last_post
        self.last_post = time.monotonic()

        def avg(k):
            v = [x[k] for x in ss if isinstance(x.get(k), (int, float))]
            return round(sum(v) / len(v), 1) if v else None

        def mx(k):
            v = [x[k] for x in ss if isinstance(x.get(k), (int, float))]
            return round(max(v), 1) if v else None

        mem = [x["ram_used"] / x["ram_total"] * 100 for x in ss if x.get("ram_total") and x.get("ram_used") is not None]
        rss = [x["ram_proc"] for x in ss if x.get("ram_proc")]
        cur = {k: float(v.get("s", 0.0)) for k, v in (totals or {}).items()}
        prev = self.last_totals if self.last_totals is not None else cur
        self.last_totals = cur
        work = {}
        for k in WORK_KEYS:
            d = cur.get(k, 0.0) - prev.get(k, 0.0)
            if d > 0.05:
                work[k] = round(min(d, max(iv, self.every, 60.0) * 2), 1)
        return {
            "iv": round(iv),
            "cpu": avg("cpu"),
            "cpu_max": mx("cpu"),
            "cpu_proc": avg("cpu_proc"),
            "gpu": avg("gpu"),
            "mem": round(sum(mem) / len(mem), 1) if mem else None,
            "rss_mb": round(max(rss) / 2**20) if rss else None,
            "threads": int(threads),
            "device": device if device in ("cpu", "directml", "cuda") else "cpu",
            "work": work,
        }

    def post(self, data: dict) -> bool:
        try:
            r = self.sb.rpc("myc_moc_push", {"p_node": self.node_id, "p": data})
            return bool(r and r.get("ok"))
        except Exception:  # noqa: BLE001 – telemetria nie może zatrzymać węzła
            self.errors += 1
            return False
