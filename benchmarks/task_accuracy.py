"""Benchmark: dokładność agenta na każdym z 32 zadań (średnia z kilku ziaren).

    python benchmarks/task_accuracy.py --out bench.json            # nowe domyślne (Adam + Leaky ReLU)
    python benchmarks/task_accuracy.py --optimizer sgd --activation relu --hidden 8 --lr 0.3

Działa też na starszych wersjach pakietu (bez parametrów optimizer/activation).
"""

from __future__ import annotations

import argparse
import inspect
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iot_mycelium.tasks import TaskFactory  # noqa: E402
from iot_mycelium.universal_agent import UniversalAgent  # noqa: E402


def run(hidden: int, lr: float, epochs: int, seeds: int, **extra) -> dict[str, list[float]]:
    params = inspect.signature(UniversalAgent).parameters
    extra = {k: v for k, v in extra.items() if k in params and v is not None}
    out: dict[str, list[float]] = {}
    for name in TaskFactory.task_names():
        task = TaskFactory.get_task(name)
        out[name] = [
            UniversalAgent(task, hidden_dim=hidden, learning_rate=lr, seed=s, **extra).train(
                epochs=epochs, verbose=False
            )["final_accuracy"]
            for s in range(seeds)
        ]
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--hidden", type=int, default=16)
    p.add_argument("--lr", type=float, default=0.1)
    p.add_argument("--epochs", type=int, default=4000)
    p.add_argument("--seeds", type=int, default=3)
    p.add_argument("--optimizer")
    p.add_argument("--activation")
    p.add_argument("--out")
    a = p.parse_args()
    t0 = time.time()
    res = run(a.hidden, a.lr, a.epochs, a.seeds, optimizer=a.optimizer, activation=a.activation)
    means = {k: float(np.mean(v)) for k, v in res.items()}
    for k, m in means.items():
        print(f"{k:<22} {m:.3f}  {np.round(res[k], 2).tolist()}")
    print(
        f"średnio {np.mean(list(means.values())):.3f}, ≥95%: {sum(m >= 0.95 for m in means.values())}/32, "
        f"{time.time() - t0:.0f}s"
    )
    if a.out:
        Path(a.out).write_text(json.dumps({"config": vars(a), "per_seed": res, "mean": means}, indent=2))


if __name__ == "__main__":
    main()
