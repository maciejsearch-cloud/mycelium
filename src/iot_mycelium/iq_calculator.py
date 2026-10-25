"""IQ Calculator – „inteligencja” agenta mierzona na danych ODŁOŻONYCH (held-out).

Poprzednia wersja liczyła IQ heurystykami (spadek loss, odchylenie accuracy,
„wzorce” w danych wejściowych) albo dokładnością na tych samych przykładach,
na których agent się uczył – czyli mierzyła zapamiętywanie, nie uogólnianie.

Teraz cztery z pięciu testów to k-krotna walidacja krzyżowa: dla każdego zadania
tabela prawdy jest dzielona na ``k`` części, agent o konfiguracji badanego agenta
(neurony ukryte, learning rate, optymalizator, aktywacja) uczy się na ``k-1``
częściach i przewiduje część pominiętą. Wynik zadania to dokładność ponad
poziom losowy (stałe zgadywanie klasy większościowej):

    score = max(0, (acc_heldout - acc_baseline) / (1 - acc_baseline))

Piąty test (pamięć) ocenia historię samego agenta: czy utrzymał najlepszy wynik.

To nadal umowna skala (max 110 pkt) do porównywania agentów, nie psychometryczne IQ.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from iot_mycelium.tasks import TaskFactory
from iot_mycelium.universal_agent import UniversalAgent


def _agent_config(agent: Any) -> dict[str, Any]:
    return {
        "hidden_dim": getattr(agent, "hidden_dim", 16),
        "learning_rate": getattr(agent, "learning_rate", 0.1),
        "optimizer": getattr(agent, "optimizer", "adam"),
        "activation": getattr(agent, "activation", "leaky_relu"),
    }


def kfold_heldout(
    task_name: str,
    config: dict[str, Any],
    k: int = 4,
    epochs: int = 1500,
    seed: int | None = 0,
    repeats: int = 2,
) -> dict[str, float]:
    """Dokładność na odłożonych przykładach (k-fold, ``repeats`` losowań podziału) i poziom losowy."""
    task = TaskFactory.get_task(task_name)
    n = len(task.X)
    k = max(2, min(k, n))
    rng = np.random.default_rng(seed)
    hits = []
    for r in range(repeats):
        folds = np.array_split(rng.permutation(n), k)
        preds = np.zeros_like(task.y)
        for i, test_idx in enumerate(folds):
            train_idx = np.concatenate([f for j, f in enumerate(folds) if j != i])
            agent_seed = None if seed is None else seed + 100 * r + i
            agent = UniversalAgent(task, seed=agent_seed, **config)
            agent.train(epochs=epochs, verbose=False, X=task.X[train_idx], y=task.y[train_idx], patience=500)
            preds[test_idx] = agent.predict(task.X[test_idx])
        hits.append(np.mean(preds == task.y))
    acc = float(np.mean(hits))
    # Poziom losowy = zawsze zgadywać klasę większościową (osobno dla każdego wyjścia).
    # Majority z foldu treningowego byłby w CV systematycznie zaniżony (anty-korelacja z foldem testowym).
    p1 = task.y.mean(axis=0)
    baseline = float(np.mean(np.maximum(p1, 1 - p1)))
    score = 0.0 if baseline >= 1.0 else max(0.0, (acc - baseline) / (1.0 - baseline))
    return {"heldout_accuracy": acc, "baseline_accuracy": baseline, "score": min(score, 1.0)}


@dataclass
class HeldOutTest:
    """Test uogólniania: średni wynik k-fold na grupie zadań."""

    name: str
    tasks: tuple[str, ...]
    max_score: int
    k: int = 4
    epochs: int = 1500
    seed: int | None = 0

    def details(self, agent: Any) -> dict[str, dict[str, float]]:
        config = _agent_config(agent)
        return {t: kfold_heldout(t, config, self.k, self.epochs, self.seed) for t in self.tasks}

    def score(self, details: dict[str, dict[str, float]]) -> int:
        return int(round(np.mean([d["score"] for d in details.values()]) * self.max_score))

    def evaluate(self, agent: Any) -> int:
        return self.score(self.details(agent))


class MemoryTest:
    """Pamięć: czy agent utrzymał najlepszą osiągniętą dokładność (historia treningu)."""

    def __init__(self, max_score: int = 10):
        self.max_score = max_score

    def evaluate(self, agent: Any) -> int:
        history = list(getattr(agent, "accuracy_history", []) or [])
        if not history:
            return 0
        best, final = max(history), history[-1]
        retained = final / best if best > 0 else 0.0
        return int(round(min(best, 1.0) * retained * self.max_score))


class AgentIQCalculator:
    """Kalkulator IQ – 4 testy uogólniania na danych odłożonych + test pamięci."""

    def __init__(self, seed: int | None = 0, k: int = 4, epochs: int = 1500):
        self.seed = seed
        self.tests: dict[str, Any] = {
            "boolean_logic": HeldOutTest(
                "boolean_logic", ("boolean_expression", "hamming_weight", "circuit_simulation"), 30, k, epochs, seed
            ),
            "pattern_recognition": HeldOutTest(
                "pattern_recognition", ("repeating_pattern", "symmetric_pattern", "palindrome"), 30, k, epochs, seed
            ),
            "math_foundation": HeldOutTest(
                "math_foundation", ("greater_than", "monotonic_sequence"), 20, k, epochs, seed
            ),
            "sequence_logic": HeldOutTest(
                "sequence_logic", ("count_ones", "gray_code", "prime_detection"), 20, k, epochs, seed
            ),
            "memory_retention": MemoryTest(max_score=10),
        }
        self.evolution_stages = {
            "foundation": {"min_iq": 0, "max_iq": 50, "description": "Logika podstawowa"},
            "patterns": {"min_iq": 51, "max_iq": 80, "description": "Wzorce i sekwencje"},
            "language": {"min_iq": 81, "max_iq": 120, "description": "Język podstawowy"},
            "reasoning": {"min_iq": 121, "max_iq": 160, "description": "Logiczne myślenie"},
            "emotional": {"min_iq": 161, "max_iq": 200, "description": "Inteligencja emocjonalna"},
        }

    @property
    def max_iq(self) -> int:
        return sum(test.max_score for test in self.tests.values())

    def calculate_iq(self, agent: Any) -> dict[str, Any]:
        scores: dict[str, int] = {}
        heldout: dict[str, dict[str, dict[str, float]]] = {}
        for name, test in self.tests.items():
            try:
                if isinstance(test, HeldOutTest):
                    heldout[name] = test.details(agent)
                    scores[name] = test.score(heldout[name])
                else:
                    scores[name] = test.evaluate(agent)
            except Exception as exc:  # pojedynczy test nie może wywrócić całego pomiaru
                scores[name] = 0
                print(f"Błąd w teście {name}: {exc}")
        total = int(sum(scores.values()))
        stage = self.determine_stage(total)
        return {
            "total_iq": total,
            "max_iq": self.max_iq,
            "breakdown": scores,
            "max_scores": {name: test.max_score for name, test in self.tests.items()},
            "heldout": heldout,
            "stage": stage,
            "next_stage_requirements": self.get_next_stage_requirements(total),
            "evolution_progress": self.calculate_evolution_progress(total, stage),
        }

    def determine_stage(self, iq_score: int) -> dict[str, Any]:
        for name, info in self.evolution_stages.items():
            if info["min_iq"] <= iq_score <= info["max_iq"]:
                return {
                    "name": name,
                    "description": info["description"],
                    "min_iq": info["min_iq"],
                    "max_iq": info["max_iq"],
                    "progress": (iq_score - info["min_iq"]) / (info["max_iq"] - info["min_iq"]),
                }
        last_name = list(self.evolution_stages)[-1]
        last = self.evolution_stages[last_name]
        return {
            "name": last_name,
            "description": last["description"],
            "min_iq": last["min_iq"],
            "max_iq": last["max_iq"],
            "progress": 1.0,
        }

    def get_next_stage_requirements(self, current_iq: int) -> dict[str, Any]:
        names = list(self.evolution_stages)
        index = names.index(self.determine_stage(current_iq)["name"])
        if index < len(names) - 1:
            nxt = self.evolution_stages[names[index + 1]]
            return {
                "next_stage": names[index + 1],
                "description": nxt["description"],
                "needed_iq": max(0, nxt["min_iq"] - current_iq),
                "target_iq": nxt["min_iq"],
            }
        return {"next_stage": "max", "description": "Maksymalny etap osiągnięty", "needed_iq": 0}

    def calculate_evolution_progress(self, iq_score: int, stage: dict[str, Any]) -> float:
        max_iq = self.evolution_stages["emotional"]["max_iq"]
        return max(0.0, min(1.0, iq_score / max_iq))
