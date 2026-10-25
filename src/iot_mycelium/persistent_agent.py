"""Persistent Agent – agent, który pamięta postępy między sesjami.

Jeden obiekt na (zadanie, hidden_dim, learning_rate) w obrębie procesu; stan
zapisywany jest w ``data/agents/<zadanie>_<hidden>_<lr>.pkl``.

Uwaga: ``pickle`` wczytuje tylko pliki, które ten program sam zapisał w katalogu
danych. Nie wczytuj plików ``.pkl`` z niezaufanych źródeł.
"""

from __future__ import annotations

import os
import pickle
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np

from iot_mycelium.memory import MyceliumMemory
from iot_mycelium.paths import agents_dir
from iot_mycelium.tasks import TaskFactory
from iot_mycelium.universal_agent import UniversalAgent


def _agent_key(task_name: str, hidden_dim: int, learning_rate: float) -> str:
    return f"{task_name}_{hidden_dim}_{learning_rate}"


class PersistentAgent:
    """Agent, który naprawdę uczy się i pamięta między sesjami."""

    _instances: dict[tuple[str, str], PersistentAgent] = {}

    def __new__(cls, task_name: str, hidden_dim: int = 16, learning_rate: float = 0.1, **_: Any):
        key = (str(agents_dir()), _agent_key(task_name, hidden_dim, learning_rate))
        if key not in cls._instances:
            cls._instances[key] = super().__new__(cls)
        return cls._instances[key]

    def __init__(
        self,
        task_name: str,
        hidden_dim: int = 16,
        learning_rate: float = 0.1,
        alpha: float = 0.7,
        mycelium: MyceliumMemory | None = None,
    ):
        if getattr(self, "_initialized", False):
            return

        self.task_name = task_name
        self.hidden_dim = hidden_dim
        self.learning_rate = learning_rate
        self.alpha = alpha
        self.save_path: Path = agents_dir() / f"{_agent_key(task_name, hidden_dim, learning_rate)}.pkl"

        self.task = TaskFactory.get_task(task_name)
        self.mycelium = mycelium or MyceliumMemory()

        self.training_sessions: list[dict[str, Any]] = []
        self.total_epochs = 0
        self.start_time = datetime.now()
        self.last_accuracy = 0.0
        self.learning_speed = 0.0

        self.agent = self._load_or_create_agent()
        self._initialized = True

    @classmethod
    def clear_cache(cls) -> None:
        """Czyści cache obiektów (przydatne w testach)."""
        cls._instances.clear()

    # ------------------------------------------------------------ zapis/odczyt
    def _load_or_create_agent(self) -> UniversalAgent:
        if not self.save_path.exists():
            return self._create_new_agent()
        try:
            with open(self.save_path, "rb") as f:
                data = pickle.load(f)  # noqa: S301 - tylko własne pliki z katalogu danych
            agent = UniversalAgent(
                task=self.task,
                hidden_dim=self.hidden_dim,
                learning_rate=self.learning_rate,
                initial_weights=data["weights"],
            )
            agent.loss_history = data.get("loss_history", [])
            agent.accuracy_history = data.get("accuracy_history", [])
            agent.weight_history = data.get("weight_history", [])
            agent.activation_history = data.get("activation_history", [])
            self.training_sessions = data.get("training_sessions", [])
            self.total_epochs = data.get("total_epochs", 0)
            self.start_time = data.get("start_time", datetime.now())
            self.last_accuracy = data.get("last_accuracy", 0.0)
            self.learning_speed = data.get("learning_speed", 0.0)
            return agent
        except Exception as exc:  # uszkodzony / niekompatybilny plik
            print(f"❌ Błąd wczytywania agenta {self.save_path.name}: {exc} – tworzę nowego")
            return self._create_new_agent()

    def _create_new_agent(self) -> UniversalAgent:
        """Nowy agent z wagami zmieszanymi z grzybni."""
        shapes = {
            "W1": (self.task.input_dim, self.hidden_dim),
            "b1": (1, self.hidden_dim),
            "W2": (self.hidden_dim, self.task.output_dim),
            "b2": (1, self.task.output_dim),
        }
        initial_weights = self.mycelium.get_fusion_weights(shapes, alpha=self.alpha)
        return UniversalAgent(
            task=self.task,
            hidden_dim=self.hidden_dim,
            learning_rate=self.learning_rate,
            initial_weights=initial_weights,
        )

    def _save_agent(self) -> None:
        self.save_path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "weights": self.agent.get_weights(),
            "loss_history": self.agent.loss_history,
            "accuracy_history": self.agent.accuracy_history,
            "weight_history": self.agent.weight_history[-50:],
            "activation_history": self.agent.activation_history[-5:],
            "training_sessions": self.training_sessions,
            "total_epochs": self.total_epochs,
            "start_time": self.start_time,
            "last_accuracy": self.last_accuracy,
            "learning_speed": self.learning_speed,
            "save_time": datetime.now().isoformat(),
        }
        tmp = self.save_path.with_suffix(".pkl.tmp")
        with open(tmp, "wb") as f:
            pickle.dump(data, f)
        os.replace(tmp, self.save_path)

    # ------------------------------------------------------------- trening
    def continue_training(self, epochs: int = 1000) -> dict[str, Any]:
        """Kontynuuje trening od zapisanych wag i aktualizuje grzybnię."""
        session_start = datetime.now()
        initial_accuracy = self.last_accuracy

        results = self.agent.train(epochs=epochs, verbose=False)

        session_end = datetime.now()
        duration = (session_end - session_start).total_seconds()
        improvement = results["final_accuracy"] - initial_accuracy
        self.learning_speed = improvement / duration if duration > 0 else 0.0

        session = {
            "session_id": len(self.training_sessions) + 1,
            "start_time": session_start.isoformat(),
            "end_time": session_end.isoformat(),
            "epochs": results["epochs_trained"],
            "initial_accuracy": initial_accuracy,
            "final_accuracy": results["final_accuracy"],
            "improvement": improvement,
            "learning_speed": self.learning_speed,
            "final_loss": results["final_loss"],
            "training_time": results["training_time"],
        }
        self.training_sessions.append(session)
        self.total_epochs += results["epochs_trained"]
        self.last_accuracy = results["final_accuracy"]

        updated = self.mycelium.update_memory(
            weights=self.agent.get_weights(),
            loss=results["final_loss"],
            metadata={
                "agent_id": _agent_key(self.task_name, self.hidden_dim, self.learning_rate),
                "task_name": self.task_name,
                "accuracy": results["final_accuracy"],
                "total_epochs": self.total_epochs,
                "learning_speed": self.learning_speed,
                "session_count": len(self.training_sessions),
            },
        )
        self._save_agent()

        results.update(
            {
                "session_id": session["session_id"],
                "total_epochs": self.total_epochs,
                "session_count": len(self.training_sessions),
                "learning_speed": self.learning_speed,
                "improvement": improvement,
                "updated_mycelium": updated,
                "agent": self.agent,
            }
        )
        return results

    def get_learning_stats(self) -> dict[str, Any]:
        if not self.training_sessions:
            return {
                "total_sessions": 0,
                "total_epochs": 0,
                "total_time": 0.0,
                "average_speed": 0.0,
                "best_accuracy": 0.0,
                "current_accuracy": 0.0,
                "improvement_trend": "insufficient_data",
                "first_accuracy": 0.0,
                "total_improvement": 0.0,
            }
        sessions = self.training_sessions
        if len(sessions) >= 3:
            avg = float(np.mean([s["improvement"] for s in sessions[-3:]]))
            trend = "improving" if avg > 0.01 else "declining" if avg < -0.01 else "stable"
        else:
            trend = "insufficient_data"
        return {
            "total_sessions": len(sessions),
            "total_epochs": self.total_epochs,
            "total_time": float(sum(s["training_time"] for s in sessions)),
            "average_speed": float(np.mean([s["learning_speed"] for s in sessions])),
            "best_accuracy": max(s["final_accuracy"] for s in sessions),
            "current_accuracy": self.last_accuracy,
            "improvement_trend": trend,
            "first_accuracy": sessions[0]["final_accuracy"],
            "total_improvement": self.last_accuracy - sessions[0]["final_accuracy"],
        }

    def reset(self) -> None:
        self.save_path.unlink(missing_ok=True)
        self.training_sessions = []
        self.total_epochs = 0
        self.start_time = datetime.now()
        self.last_accuracy = 0.0
        self.learning_speed = 0.0
        self.agent = self._create_new_agent()


def get_persistent_agent(
    task_name: str, hidden_dim: int = 16, learning_rate: float = 0.1, alpha: float = 0.7
) -> PersistentAgent:
    """Pobiera (lub tworzy) persistent agenta."""
    return PersistentAgent(task_name, hidden_dim, learning_rate, alpha=alpha)


def list_all_agents() -> dict[str, dict[str, Any]]:
    """Lista zapisanych agentów (klucz = nazwa pliku bez rozszerzenia)."""
    agents: dict[str, dict[str, Any]] = {}
    for path in sorted(agents_dir().glob("*.pkl")):
        try:
            with open(path, "rb") as f:
                data = pickle.load(f)  # noqa: S301
        except Exception as exc:
            print(f"Błąd wczytywania agenta {path.name}: {exc}")
            continue
        task_name, hidden, lr = path.stem.rsplit("_", 2)
        agents[path.stem] = {
            "file": path.name,
            "task_name": task_name,
            "hidden_dim": int(hidden),
            "learning_rate": float(lr),
            "total_epochs": data.get("total_epochs", 0),
            "sessions": len(data.get("training_sessions", [])),
            "last_accuracy": data.get("last_accuracy", 0.0),
            "learning_speed": data.get("learning_speed", 0.0),
            "save_time": data.get("save_time", "Unknown"),
        }
    return agents
