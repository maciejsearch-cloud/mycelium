"""Pomiar Puzzle #71 na tym komputerze: klucze/s (C i Python, pełny rdzeń) oraz spowolnienie treningu torch przy
włączonym wątku p71 (nice 19, cykl pracy jak w węźle). Naprzemiennie: bez p71 / z p71, po `--secs` sekund, `--reps` razy.
Wynik: results/p71/bench-<data>.json (prawdziwe pomiary; obciążenie reszty komputera zapisane obok).

Użycie: python scripts/p71_bench.py --threads 4 --pct 10 --secs 45 --reps 3
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import threading
import time
from pathlib import Path

from iot_mycelium.mesh.p71 import RANGE_LO, TARGET_H160, core
from iot_mycelium.mesh.p71.worker import SLICE, lower_thread_priority


def keys_per_s(scan, n: int) -> float:
    t = time.perf_counter()
    scan(RANGE_LO + 12345, n, bytes.fromhex(TARGET_H160))
    return n / (time.perf_counter() - t)


class Duty(threading.Thread):
    def __init__(self, cc, duty: float):
        super().__init__(daemon=True)
        self.cc, self.duty, self.stop, self.keys, self.cpu = cc, duty, threading.Event(), 0, 0.0

    def run(self):
        self.prio = lower_thread_priority()
        off = 0
        while not self.stop.is_set():
            c0 = time.thread_time()
            self.cc.scan(RANGE_LO + off, SLICE, bytes(20))
            c = time.thread_time() - c0
            self.cpu += c
            off += SLICE
            self.keys += SLICE
            self.stop.wait(max(c, 0.001) * (1 / self.duty - 1))


def train_steps(secs: float) -> float:
    import torch

    torch.manual_seed(0)
    m = torch.nn.Sequential(torch.nn.Linear(768, 3072), torch.nn.GELU(), torch.nn.Linear(3072, 768))
    opt = torch.optim.AdamW(m.parameters(), 1e-4)
    x = torch.randn(256, 768)
    n, t0 = 0, time.perf_counter()
    while time.perf_counter() - t0 < secs:
        loss = m(x).pow(2).mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
        n += 1
    return n / (time.perf_counter() - t0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--pct", type=float, default=10)
    ap.add_argument("--secs", type=float, default=45)
    ap.add_argument("--reps", type=int, default=3)
    a = ap.parse_args()
    import torch

    torch.set_num_threads(a.threads)
    os.nice(19 - os.nice(0))  # jak węzeł: supervise.sh (nice 10) + low_priority() (+10) = nice 19
    cc = core.load()
    out = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "cpu_count": os.cpu_count(), "threads": a.threads, "pct": a.pct,
           "loadavg_start": os.getloadavg()}  # fmt: skip
    out["c_keys_s_full_core"] = round(keys_per_s(cc.scan, 1 << 23)) if cc else None
    out["py_keys_s_full_core"] = round(keys_per_s(core.scan_py, 1 << 15))
    duty = min(1.0, a.pct / 100 * a.threads)
    off, on, rates = [], [], []
    for _ in range(a.reps):
        off.append(train_steps(a.secs))
        d = Duty(cc, duty)
        d.start()
        t0 = time.perf_counter()
        on.append(train_steps(a.secs))
        d.stop.set()
        d.join()
        dt = time.perf_counter() - t0
        rates.append({"keys_s": round(d.keys / dt), "cpu_frac": round(d.cpu / dt, 3), "prio": d.prio})
    off.append(train_steps(a.secs))
    out.update({
        "duty_core": duty,
        "train_steps_s_off": [round(v, 3) for v in off],
        "train_steps_s_on": [round(v, 3) for v in on],
        "p71_during_train": rates,
        "slowdown_pct": round((1 - statistics.mean(on) / statistics.mean(off)) * 100, 2),
        "loadavg_end": os.getloadavg(),
    })  # fmt: skip
    p = Path("results/p71") / f"bench-{time.strftime('%Y-%m-%d-%H%M')}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
