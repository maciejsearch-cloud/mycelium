"""Eksport danych z obecnego systemu do statycznego JSON-a dla frontendu (tryb nagrany/demo).

    python scripts/export_frontend_data.py --out web/public/data/snapshot.json

Uruchamia prawdziwe treningi w tymczasowym katalogu danych (nic nie trafia do data/):
benchmark 32 zadań (przed/po fazie 2), auto-ewolucję, agentów trwałych + sloty grzybni,
krzywe uczenia i IQ na danych odłożonych. Dodatkowe pliki z wynikami (np. benchmark
fazy 3) można dołączyć przez ``--extra nazwa=plik.json``.

Wyniki prawdziwego AI (``python -m iot_mycelium ai-bench``) trafiają do klucza ``ai``.
Szybka aktualizacja tylko tej sekcji (bez ponownego liczenia starego systemu):

    python scripts/export_frontend_data.py --ai-only --ai results/ai_benchmark.json
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "benchmarks"))


def _f(x: float) -> float:
    return round(float(x), 4)


def bench(label: str, **cfg) -> dict:
    from task_accuracy import run

    t0 = time.perf_counter()
    res = run(epochs=4000, seeds=3, **cfg)
    means = {k: _f(np.mean(v)) for k, v in res.items()}
    return {
        "label": label,
        "config": cfg,
        "mean": means,
        "overall": _f(np.mean(list(means.values()))),
        "mastered": sum(m >= 0.95 for m in means.values()),
        "seconds": _f(time.perf_counter() - t0),
    }


def curves() -> list[dict]:
    from iot_mycelium.tasks import TaskFactory
    from iot_mycelium.universal_agent import UniversalAgent

    out = []
    for name in ("xor", "4bit_parity", "palindrome", "gray_code", "prime_detection", "is_power_of_two"):
        for label, kw in (
            ("Adam + Leaky ReLU (h16, lr 0.1)", {"hidden_dim": 16, "learning_rate": 0.1}),
            (
                "SGD + ReLU (h8, lr 0.3, stare)",
                {"hidden_dim": 8, "learning_rate": 0.3, "optimizer": "sgd", "activation": "relu"},
            ),
        ):
            agent = UniversalAgent(TaskFactory.get_task(name), seed=0, **kw)
            r = agent.train(epochs=3000, verbose=False)
            step = max(1, len(agent.loss_history) // 120)
            out.append(
                {
                    "task": name,
                    "config": label,
                    "every_epochs": 10 * step,
                    "loss": [_f(v) for v in agent.loss_history[::step]],
                    "accuracy": [_f(v) for v in agent.accuracy_history[::step]],
                    "final_accuracy": _f(r["final_accuracy"]),
                    "epochs": r["epochs_trained"],
                }
            )
    return out


def agents_and_slots() -> tuple[list[dict], list[dict], dict]:
    from iot_mycelium.iq_calculator import AgentIQCalculator
    from iot_mycelium.memory import MyceliumMemory
    from iot_mycelium.persistent_agent import PersistentAgent

    agents = []
    iq_calc = AgentIQCalculator(epochs=800)
    iq_rows = {}
    for task, hidden in (
        ("xor", 16),
        ("xor", 8),
        ("4bit_parity", 16),
        ("palindrome", 32),
        ("gray_code", 16),
        ("majority", 8),
    ):
        a = PersistentAgent(task, hidden_dim=hidden, learning_rate=0.1)
        for _ in range(2):
            a.continue_training(epochs=1500)
        s = a.get_learning_stats()
        row = {
            k: (v if isinstance(v, int | str | bool | None) else _f(v) if isinstance(v, float) else str(v))
            for k, v in s.items()
            if not isinstance(v, list | dict)
        }
        row.update({"task": task, "hidden_dim": hidden, "id": f"{task}-h{hidden}"})
        if (task, hidden) in {("xor", 16), ("4bit_parity", 16), ("palindrome", 32)}:
            iq = iq_calc.calculate_iq(a.agent)
            iq_rows[row["id"]] = {
                "total_iq": iq["total_iq"],
                "max_iq": iq["max_iq"],
                "breakdown": iq["breakdown"],
                "max_scores": iq["max_scores"],
                "stage": iq["stage"].get("name"),
            }
            row["iq"] = iq["total_iq"]
        agents.append(row)
    slots = MyceliumMemory().list_slots()
    for s in slots:
        s["best_loss"] = _f(s["best_loss"])
        if s.get("accuracy") is not None:
            s["accuracy"] = _f(s["accuracy"])
    return agents, slots, iq_rows


def evolution(previous: Path | None) -> dict:
    from iot_mycelium.auto_evolution import ContinuousEvolutionSystem

    sysm = ContinuousEvolutionSystem(max_attempts_per_task=6, epoch_scale=0.5)
    r = sysm.run_full_evolution(save=False)
    tasks = [
        {
            "task": t["task_name"],
            "success": t["success"],
            "best_accuracy": _f(t["best_accuracy"]),
            "seconds": _f(t["total_time"]),
            "attempts": [
                {
                    "hidden": a["hidden_dim"],
                    "lr": a["learning_rate"],
                    "epochs": a["epochs"],
                    "accuracy": _f(a["final_accuracy"]),
                }
                for a in t["attempts"]
            ],
        }
        for t in r["evolution_log"]
    ]
    out = {"after": {"tasks": tasks, "mastered": len(r["tasks_mastered"]), "seconds": _f(r["total_time"])}}
    if previous and previous.exists():
        p = json.loads(previous.read_text())
        out["before"] = {
            "accuracy": {k: _f(v) for k, v in p["acc"].items()},
            "mastered": p["mastered"],
            "seconds": _f(p["time"]),
        }
    return out


LEGACY_KEYS = ("tasks", "benchmarks", "evolution", "curves", "agents", "slots", "iq")


def ai_section(path: Path) -> dict | None:
    """Wyniki ai-bench w formie dla frontendu (bez ciężkich pól, liczby zaokrąglone)."""
    if not path.exists():
        return None
    res = json.loads(path.read_text())
    if res.get("synthetic"):
        # dane syntetyczne służą tylko testom – nigdy nie trafiają do UI
        raise SystemExit(f"{path}: wyniki na danych syntetycznych – odmawiam eksportu do frontendu")

    def rnd(x):
        if isinstance(x, float):
            return round(x, 4)
        if isinstance(x, dict):
            return {k: rnd(v) for k, v in x.items()}
        if isinstance(x, list):
            return [rnd(v) for v in x]
        return x

    for a in res.get("agents", []):
        a["tuning"]["trials"] = a["tuning"]["trials"][:12]
    from iot_mycelium.ai.history import append, load

    hist = path.parent / "ai_history.jsonl"
    append(res, hist)  # uzupełnia historię, jeśli ten przebieg jeszcze w niej nie jest
    res["history"] = load(hist)
    return rnd(res)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "web" / "public" / "data" / "snapshot.json"))
    ap.add_argument("--evo-before", help="JSON z auto-ewolucji sprzed fazy 2 (porównanie)")
    ap.add_argument("--extra", action="append", default=[])
    ap.add_argument("--ai", default=str(ROOT / "results" / "ai_benchmark.json"), help="wyniki ai-bench")
    ap.add_argument("--legacy", action="store_true", help="zachowaj sekcje zadań-zabawek (tylko lokalnie)")
    ap.add_argument("--ai-only", action="store_true", help="podmień tylko sekcję ai w istniejącym snapshocie")
    a = ap.parse_args()
    if a.ai_only:
        snap = json.loads(Path(a.out).read_text())
        snap["ai"] = ai_section(Path(a.ai))
        Path(a.out).write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":"), default=str))
        print(f"zaktualizowano sekcję ai w {a.out} ({Path(a.out).stat().st_size // 1024} KB)")
        return
    os.environ["IOT_MYCELIUM_DATA_DIR"] = tempfile.mkdtemp(prefix="mycelium-export-")
    t0 = time.perf_counter()
    from iot_mycelium.tasks import TaskFactory

    tasks = [
        {"name": n, "difficulty": TaskFactory.get_task(n).difficulty, "inputs": int(TaskFactory.get_task(n).X.shape[1])}
        for n in TaskFactory.task_names()
    ]
    snap = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "machine": {"python": platform.python_version(), "cpu": os.cpu_count()},
        "tasks": tasks,
        "benchmarks": [
            bench("Przed: SGD + ReLU, h8, lr 0.3", hidden=8, lr=0.3, optimizer="sgd", activation="relu"),
            bench("Strojone SGD + ReLU, h16, lr 0.1", hidden=16, lr=0.1, optimizer="sgd", activation="relu"),
            bench("Po: Adam + Leaky ReLU, h16, lr 0.1", hidden=16, lr=0.1),
        ],
        "evolution": evolution(Path(a.evo_before) if a.evo_before else None),
        "curves": curves(),
    }
    snap["agents"], snap["slots"], snap["iq"] = agents_and_slots()
    if ai := ai_section(Path(a.ai)):
        snap["ai"] = ai
    for item in a.extra:
        key, path = item.split("=", 1)
        snap[key] = json.loads(Path(path).read_text())
    snap["export_seconds"] = _f(time.perf_counter() - t0)
    if not a.legacy:
        # sekcje zadań-zabawek (XOR itp., dane generowane) nie trafiają do publicznego UI
        for k in LEGACY_KEYS:
            snap.pop(k, None)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":"), default=str))
    print(f"zapisano {a.out} ({Path(a.out).stat().st_size // 1024} KB) w {snap['export_seconds']} s")


if __name__ == "__main__":
    main()
