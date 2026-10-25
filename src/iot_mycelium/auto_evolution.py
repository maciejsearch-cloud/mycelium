"""Continuous Evolution System – automatyczne uczenie wszystkich zadań.

Dla każdego zadania system przeszukuje siatkę (hidden_dim × learning_rate),
trenuje persistent agentów (którzy pamiętają postęp między uruchomieniami)
i zatrzymuje się, gdy dokładność osiągnie ``mastery_threshold``.

Naprawione względem poprzedniej wersji: brakująca metoda
``_save_evolution_results``, nieistniejąca klasa ``AutoEvolutionSystem``,
``_train_single_attempt`` zwracające ``None`` przy błędzie (co wywracało całą
ewolucję) oraz pusty ``get_optimization_summary``.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterable
from datetime import datetime
from itertools import product
from pathlib import Path
from typing import Any

from iot_mycelium.paths import evolution_dir
from iot_mycelium.persistent_agent import get_persistent_agent
from iot_mycelium.tasks import TaskFactory

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[str], None]

STRATEGY_BY_DIFFICULTY: dict[str, dict[str, Any]] = {
    "easy": {"base_epochs": 1000, "hidden_dims": [8, 16], "learning_rates": [0.1, 0.03]},
    "medium": {"base_epochs": 2000, "hidden_dims": [16, 32], "learning_rates": [0.1, 0.03]},
    "hard": {"base_epochs": 4000, "hidden_dims": [16, 32, 64], "learning_rates": [0.1, 0.03, 0.01]},
}
# Zadania z jednym wejściem liczbowym potrzebują wielu „załamań” funkcji → szersza sieć, dłuższy trening.
STRATEGY_OVERRIDES: dict[str, dict[str, Any]] = {
    "fibonacci_mod2": {"base_epochs": 8000, "hidden_dims": [32, 64], "learning_rates": [0.1, 0.03]},
    "is_power_of_two": {"base_epochs": 8000, "hidden_dims": [32, 64], "learning_rates": [0.1, 0.03]},
}
DEFAULT_STRATEGY: dict[str, Any] = STRATEGY_BY_DIFFICULTY["medium"]


class ContinuousEvolutionSystem:
    """System ciągłej ewolucji: uczy zadania do perfekcji i zapamiętuje postępy."""

    MIN_EPOCHS = 200
    MAX_EPOCHS = 10_000

    def __init__(
        self,
        task_names: Iterable[str] | None = None,
        mastery_threshold: float = 0.98,
        max_attempts_per_task: int = 50,
        epoch_scale: float = 1.0,
    ):
        all_tasks = TaskFactory.list_tasks()
        names = list(task_names) if task_names is not None else list(all_tasks)
        unknown = [n for n in names if n not in all_tasks]
        if unknown:
            raise ValueError(f"Nieznane zadania: {unknown}")
        self.tasks = {n: all_tasks[n] for n in names}
        self.mastery_threshold = mastery_threshold
        self.perfection_threshold = mastery_threshold  # alias zgodności
        self.max_attempts_per_task = max_attempts_per_task
        self.epoch_scale = epoch_scale
        self.evolution_log: list[dict[str, Any]] = []
        self.mastered_tasks: set[str] = set()
        self.global_start_time = datetime.now()

        # Siatki dobrane pod Adam + Leaky ReLU (benchmarks/task_accuracy.py).
        self.task_strategies: dict[str, dict[str, Any]] = {
            name: dict(STRATEGY_BY_DIFFICULTY[info["difficulty"]]) for name, info in self.tasks.items()
        }
        for name, override in STRATEGY_OVERRIDES.items():
            if name in self.task_strategies:
                self.task_strategies[name] = dict(override)

    # ------------------------------------------------------------ strategia
    def strategy_for(self, task_name: str) -> dict[str, Any]:
        return self.task_strategies.get(task_name, DEFAULT_STRATEGY)

    def configs_for(self, task_name: str) -> list[tuple[int, float]]:
        strategy = self.strategy_for(task_name)
        grid = list(product(strategy["hidden_dims"], strategy["learning_rates"]))
        return grid[: self.max_attempts_per_task]

    def _calculate_epochs(self, task_name: str, hidden_dim: int, learning_rate: float, attempt: int) -> int:
        # Adam normalizuje krok, więc liczba epok nie musi rosnąć odwrotnie do learning rate
        # (stary wzór base/lr dawał nawet 100× więcej epok dla lr=0.01).
        base = self.strategy_for(task_name)["base_epochs"]
        lr_modifier = 1.0 + 0.5 * (learning_rate < 0.05)
        attempt_modifier = 1.0 + (attempt - 1) * 0.2
        epochs = int(base * lr_modifier * attempt_modifier * self.epoch_scale)
        return max(self.MIN_EPOCHS, min(self.MAX_EPOCHS, epochs))

    # -------------------------------------------------------------- kroki
    def evolve_step(self, task_name: str, attempt: int = 1) -> dict[str, Any]:
        """Jeden krok ewolucji: trening jednej konfiguracji z siatki (attempt liczony od 1)."""
        configs = self.configs_for(task_name)
        hidden_dim, learning_rate = configs[(attempt - 1) % len(configs)]
        epochs = self._calculate_epochs(task_name, hidden_dim, learning_rate, attempt)
        return self._train_single_attempt(task_name, hidden_dim, learning_rate, epochs)

    def _train_single_attempt(
        self, task_name: str, hidden_dim: int, learning_rate: float, epochs: int
    ) -> dict[str, Any]:
        base = {
            "attempt_id": f"{task_name}_{hidden_dim}_{learning_rate}_{datetime.now():%H%M%S}",
            "task_name": task_name,
            "hidden_dim": hidden_dim,
            "learning_rate": learning_rate,
            "epochs": epochs,
            "timestamp": datetime.now().isoformat(),
        }
        try:
            agent = get_persistent_agent(task_name, hidden_dim, learning_rate)
            results = agent.continue_training(epochs=epochs)
            stats = agent.get_learning_stats()
        except Exception as exc:  # jedna nieudana próba nie może zatrzymać ewolucji
            logger.exception("Błąd w próbie %s", task_name)
            return {
                **base,
                "final_accuracy": 0.0,
                "final_loss": float("inf"),
                "training_time": 0.0,
                "total_sessions": 0,
                "learning_speed": 0.0,
                "improvement_trend": "error",
                "success": False,
                "error": str(exc),
            }
        return {
            **base,
            "final_accuracy": results["final_accuracy"],
            "final_loss": results["final_loss"],
            "training_time": results["training_time"],
            "total_sessions": stats["total_sessions"],
            "learning_speed": stats["average_speed"],
            "improvement_trend": stats["improvement_trend"],
            "success": results["final_accuracy"] >= self.mastery_threshold,
        }

    def _master_task(self, task_name: str, progress_callback: ProgressCallback | None = None) -> dict[str, Any]:
        """Przeszukuje siatkę konfiguracji, aż zadanie zostanie opanowane."""
        task_result: dict[str, Any] = {
            "task_name": task_name,
            "success": False,
            "best_accuracy": 0.0,
            "attempts": [],
            "total_time": 0.0,
            "optimal_params": None,
        }
        started = datetime.now()
        configs = self.configs_for(task_name)
        for attempt, (hidden_dim, learning_rate) in enumerate(configs, start=1):
            if progress_callback:
                progress_callback(
                    f"🔄 {task_name.upper()} - próba {attempt}/{len(configs)}: H={hidden_dim}, LR={learning_rate}"
                )
            result = self.evolve_step(task_name, attempt)
            task_result["attempts"].append(result)
            if result["final_accuracy"] > task_result["best_accuracy"] or task_result["optimal_params"] is None:
                task_result["best_accuracy"] = result["final_accuracy"]
                task_result["optimal_params"] = {
                    "hidden_dim": result["hidden_dim"],
                    "learning_rate": result["learning_rate"],
                    "epochs": result["epochs"],
                }
            if result["success"]:
                task_result["success"] = True
                break
        task_result["total_time"] = (datetime.now() - started).total_seconds()
        return task_result

    def run_full_evolution(
        self, progress_callback: ProgressCallback | None = None, save: bool = True
    ) -> dict[str, Any]:
        """Uczy po kolei wszystkie zadania z ``self.tasks``."""
        start = datetime.now()
        results: dict[str, Any] = {
            "start_time": start.isoformat(),
            "tasks_mastered": [],
            "tasks_failed": [],
            "total_time": 0.0,
            "total_sessions": 0,
            "evolution_log": [],
        }
        for task_name in self.tasks:
            if progress_callback:
                progress_callback(f"🎯 Pracuję nad zadaniem: {task_name.upper()}")
            task_result = self._master_task(task_name, progress_callback)
            results["evolution_log"].append(task_result)
            self.evolution_log.append(task_result)
            if task_result["success"]:
                results["tasks_mastered"].append(task_name)
                self.mastered_tasks.add(task_name)
            else:
                results["tasks_failed"].append(task_name)
            if progress_callback:
                icon = "✅" if task_result["success"] else "❌"
                progress_callback(f"{icon} {task_name.upper()}: {task_result['best_accuracy']:.3f}")
        results["end_time"] = datetime.now().isoformat()
        results["total_time"] = (datetime.now() - start).total_seconds()
        results["total_sessions"] = sum(len(t["attempts"]) for t in results["evolution_log"])
        if save:
            results["saved_to"] = str(self._save_evolution_results(results))
        return results

    def _save_evolution_results(self, results: dict[str, Any]) -> Path:
        path = evolution_dir() / f"evolution_{datetime.now():%Y%m%d_%H%M%S_%f}.json"
        with open(path, "w") as f:
            json.dump(results, f, indent=2, default=str)
        return path

    def get_optimization_summary(self) -> dict[str, Any]:
        """Najlepsza konfiguracja dla każdego zadania z dotychczasowych przebiegów."""
        summary: dict[str, Any] = {}
        for log in self.evolution_log:
            name = log["task_name"]
            if name not in summary or log["best_accuracy"] > summary[name]["best_accuracy"]:
                summary[name] = {
                    "best_accuracy": log["best_accuracy"],
                    "optimal_params": log["optimal_params"],
                    "attempts_needed": len(log["attempts"]),
                    "total_time": log["total_time"],
                }
        return summary

    def get_current_status(self) -> dict[str, Any]:
        return {
            "tasks": list(self.tasks),
            "mastered": sorted(self.mastered_tasks),
            "runs_logged": len(self.evolution_log),
            "mastery_threshold": self.mastery_threshold,
        }


# Alias zachowany dla starego kodu, który importował AutoEvolutionSystem.
AutoEvolutionSystem = ContinuousEvolutionSystem


def run_auto_evolution(progress_callback: ProgressCallback | None = None, **kwargs: Any) -> dict[str, Any]:
    return ContinuousEvolutionSystem(**kwargs).run_full_evolution(progress_callback)


def get_evolution_status() -> dict[str, Any]:
    return ContinuousEvolutionSystem().get_current_status()


def load_evolution_history(limit: int = 20) -> list[dict[str, Any]]:
    """Ostatnie zapisane przebiegi ewolucji (najnowsze pierwsze)."""
    runs = []
    for path in sorted(evolution_dir().glob("evolution_*.json"), reverse=True)[:limit]:
        try:
            runs.append(json.loads(path.read_text()))
        except (OSError, json.JSONDecodeError):
            continue
    return runs
