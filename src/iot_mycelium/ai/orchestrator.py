"""Orkiestrator Mycelium AI: agent na zadanie, strojenie Optuną z ciepłym startem z pamięci,
federacja między urządzeniami i zapis doświadczeń do wspólnej pamięci wektorowej.

    python -m iot_mycelium ai-bench --out results/ai_benchmark.json

Zasady uczciwości: hiperparametry wybierane tylko na walidacji, test używany raz na końcu.
"""

from __future__ import annotations

import os
import platform
import subprocess
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .datasets import TASK_INFO, TASKS, TaskData, load_task
from .federated import FedConfig, compare
from .models import ModelSpec, build_model, compatible_archs, count_params, default_spec, model_bytes
from .score import mbs
from .training import TrainConfig, evaluate, set_threads, train_model
from .vector_memory import VectorMemory, task_embedding


def ai_home() -> Path:
    return Path(os.environ.get("IOT_MYCELIUM_AI_DIR", Path.home() / ".cache" / "iot-mycelium" / "ai"))


@dataclass
class Budget:
    trials: int = 6
    tune_epochs: int = 2
    tune_samples: int = 6000
    epochs: int = 8
    fed_rounds: int = 8
    fed_clients: int = 8
    federated_tasks: tuple[str, ...] = ("har", "fashion_mnist")

    @classmethod
    def quick(cls) -> Budget:
        return cls(trials=2, tune_epochs=1, tune_samples=400, epochs=2, fed_rounds=2, fed_clients=3)


def params_to_spec(p: dict[str, Any], base: ModelSpec) -> tuple[ModelSpec, dict[str, float]]:
    hidden = tuple([p["width"]] * p["depth"])  # depth 0 = model liniowy
    kw: dict[str, Any] = {"arch": p["arch"], "hidden": hidden, "activation": p["activation"], "dropout": p["dropout"]}
    if p["arch"] == "cnn":
        kw["channels"] = (p["ch"], p["ch"] * 2)
    if p["arch"] == "text":
        kw["emb_dim"] = p["emb"]
    if p["arch"] == "gru":
        kw["rnn_hidden"] = p["rnn"]
    return base.with_(**kw), {"lr": p["lr"], "weight_decay": p["wd"]}


def spec_to_params(spec: ModelSpec, lr: float, wd: float) -> dict[str, Any]:
    p: dict[str, Any] = {
        "arch": spec.arch,
        "width": spec.hidden[0] if spec.hidden else 64,
        "depth": len(spec.hidden),
        "activation": spec.activation,
        "dropout": spec.dropout,
        "lr": lr,
        "wd": wd,
    }
    if spec.arch == "cnn":
        p["ch"] = spec.channels[0]
    if spec.arch == "text":
        p["emb"] = spec.emb_dim
    if spec.arch == "gru":
        p["rnn"] = spec.rnn_hidden
    return p


def _suggest(trial: Any, task: TaskData) -> dict[str, Any]:
    p = {
        "arch": trial.suggest_categorical("arch", list(compatible_archs(task))),
        "width": trial.suggest_categorical("width", [64, 128, 256]),
        "depth": trial.suggest_int("depth", 0, 2),
        "activation": trial.suggest_categorical("activation", ["relu", "gelu", "leaky_relu"]),
        "dropout": trial.suggest_float("dropout", 0.0, 0.4),
        "lr": trial.suggest_float("lr", 5e-4, 5e-3, log=True),
        "wd": trial.suggest_float("wd", 1e-5, 1e-3, log=True),
    }
    if p["arch"] == "cnn":
        p["ch"] = trial.suggest_categorical("ch", [8, 16, 32])
    if p["arch"] == "text":
        p["emb"] = trial.suggest_categorical("emb", [64, 96, 128])
    if p["arch"] == "gru":
        p["rnn"] = trial.suggest_categorical("rnn", [16, 32, 64])
    return p


def _valid_for(p: dict[str, Any], task: TaskData) -> dict[str, Any] | None:
    """Parametry z pamięci przycięte do przestrzeni tego zadania (albo None, gdy się nie da)."""
    if p.get("arch") not in compatible_archs(task):
        return None
    keep = {
        "arch",
        "width",
        "depth",
        "activation",
        "dropout",
        "lr",
        "wd",
        {"cnn": "ch", "text": "emb", "gru": "rnn"}.get(p["arch"], ""),
    }
    q = {k: v for k, v in p.items() if k in keep}
    q["lr"] = float(np.clip(q["lr"], 5e-4, 5e-3))
    q["wd"] = float(np.clip(q["wd"], 1e-5, 1e-3))
    q["dropout"] = float(np.clip(q["dropout"], 0.0, 0.4))
    return q


@dataclass
class Agent:
    task: TaskData
    budget: Budget
    memory: VectorMemory
    seed: int = 0
    log: list[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return f"agent-{self.task.name}"

    def _fit(
        self, spec: ModelSpec, hp: dict[str, float], epochs: int, X: np.ndarray, y: np.ndarray
    ) -> tuple[torch.nn.Module, dict]:
        m = build_model(spec, self.task, seed=self.seed)
        cfg = TrainConfig(epochs=epochs, lr=hp["lr"], weight_decay=hp["weight_decay"], batch_size=64, seed=self.seed)
        return m, train_model(m, self.task, X, y, cfg)

    def tune(self) -> dict[str, Any]:
        import optuna

        optuna.logging.set_verbosity(optuna.logging.WARNING)
        t = self.task
        rng = np.random.default_rng(self.seed)
        idx = rng.permutation(len(t.X_train))[: self.budget.tune_samples]
        Xs, ys = t.X_train[idx], t.y_train[idx]
        emb = task_embedding(t)
        warm = None
        for rec in self.memory.search(emb, k=5):
            if rec.get("task") != t.name and (q := _valid_for(rec["params"], t)):
                warm = {"from": rec["task"], "similarity": round(rec["similarity"], 3), "params": q}
                break
        study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=self.seed))
        base = default_spec(t.name)
        study.enqueue_trial(spec_to_params(base, 2e-3, 1e-4))
        if warm:
            study.enqueue_trial(warm["params"])

        def objective(trial: Any) -> float:
            spec, hp = params_to_spec(_suggest(trial, t), base)
            m, _ = self._fit(
                spec, {"lr": hp["lr"], "weight_decay": hp["weight_decay"]}, self.budget.tune_epochs, Xs, ys
            )
            return evaluate(m, t, t.X_val, t.y_val)["score"]

        study.optimize(objective, n_trials=self.budget.trials + (1 if warm else 0) + 1)
        trials = [{"n": tr.number, "val": round(tr.value or 0.0, 4), **tr.params} for tr in study.trials]
        warm_rank = None
        if warm:
            vals = sorted((tr["val"] for tr in trials), reverse=True)
            warm_rank = vals.index(trials[1]["val"]) + 1
        return {
            "best": study.best_params,
            "best_val": study.best_value,
            "trials": trials,
            "warm_start": warm,
            "warm_rank": warm_rank,
        }

    def run(self, models_dir: Path | None = None) -> dict[str, Any]:
        t, start = self.task, time.perf_counter()
        base = default_spec(t.name)
        # 1) baseline liniowy (regresja logistyczna / liniowa)
        lin_spec = base.with_(arch="mlp" if base.arch in ("cnn", "mlp") else base.arch, hidden=(), dropout=0.0)
        lin_hp = {"lr": 2e-3, "weight_decay": 1e-4}
        lin, _ = self._fit(lin_spec, lin_hp, self.budget.epochs, t.X_train, t.y_train)
        linear = evaluate(lin, t, t.X_test, t.y_test)
        lin_val = evaluate(lin, t, t.X_val, t.y_val)
        # 2) strojenie (walidacja) + 3) pełny trening najlepszej konfiguracji
        tuning = self.tune()
        spec, hp = params_to_spec(tuning["best"], base)
        model, tr = self._fit(
            spec, {"lr": hp["lr"], "weight_decay": hp["weight_decay"]}, self.budget.epochs, t.X_train, t.y_train
        )
        val = evaluate(model, t, t.X_val, t.y_val)
        selected = "tuned"
        if lin_val["score"] > val["score"]:  # wybór wyłącznie na walidacji
            model, spec, hp, val, selected = lin, lin_spec, lin_hp, lin_val, "linear"
        test = evaluate(model, t, t.X_test, t.y_test)
        params = spec_to_params(spec, hp["lr"], hp["weight_decay"])
        self.memory.add(
            task_embedding(t),
            {
                "task": t.name,
                "kind": t.kind,
                "spec": spec.label(),
                "params": params,
                "val": round(val["score"], 4),
                "test": round(test["score"], 4),
                "agent": self.name,
                "at": datetime.now(UTC).isoformat(),
            },
        )
        if models_dir:
            models_dir.mkdir(parents=True, exist_ok=True)
            torch.save(
                {
                    "spec": spec.to_dict(),
                    "state": model.state_dict(),
                    "class_names": t.class_names,
                    "input_shape": list(t.input_shape),
                    "kind": t.kind,
                    "input_kind": t.input_kind,
                    "n_classes": t.n_classes,
                    "test": test,
                },
                models_dir / f"{t.name}.pt",
            )
        return {
            "agent": self.name,
            "task": t.name,
            "summary": t.summary(),
            "linear": linear,
            "selected": selected,
            "model": {
                "spec": spec.label(),
                "params": params,
                "n_params": count_params(model),
                "bytes": model_bytes(model),
            },
            "val": val,
            "test": test,
            "losses": [round(x, 5) for x in tr["losses"]],
            "train_seconds": round(tr["seconds"], 2),  # trening strojonej konfiguracji
            "tuning": tuning,
            "seconds": round(time.perf_counter() - start, 2),
        }


def _git_sha() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,  # noqa: S603, S607
            cwd=Path(__file__).parent,
        ).stdout.strip()
    except Exception:
        return None


class Orchestrator:
    def __init__(
        self,
        tasks: tuple[str, ...] = TASKS,
        budget: Budget | None = None,
        home: Path | None = None,
        synthetic: bool | None = None,
        seed: int = 0,
        fresh_memory: bool = False,
    ):
        self.tasks, self.budget, self.seed, self.synthetic = tasks, budget or Budget(), seed, synthetic
        self.home = home or ai_home()
        self.memory = VectorMemory(self.home / "memory", load=not fresh_memory)

    def run(self, federated: bool = True, on_event: Any = None) -> dict[str, Any]:
        set_threads()
        emit = on_event or (lambda *_: None)
        start = time.perf_counter()
        agents, fed = [], []
        loaded = {}
        for name in self.tasks:
            task = loaded[name] = load_task(name, seed=self.seed, synthetic=self.synthetic)
            emit("agent_start", {"task": name})
            res = Agent(task, self.budget, self.memory, self.seed).run(self.home / "models")
            agents.append(res)
            emit("agent_done", {"task": name, "score": res["test"]["score"]})
        if federated:
            for name in self.budget.federated_tasks:
                if name not in loaded:
                    continue
                t = loaded[name]
                part = "natural" if t.groups_train is not None and name == "har" else "dirichlet"
                cfg = FedConfig(
                    n_clients=self.budget.fed_clients, rounds=self.budget.fed_rounds, partition=part, seed=self.seed
                )
                fed.append(compare(t, default_spec(name), cfg, TrainConfig(batch_size=64, lr=2e-3)))
                emit("federated_done", {"task": name})
        self.memory.save()
        scores = {a["task"]: a["test"]["score"] for a in agents}
        return {
            "generated_at": datetime.now(UTC).isoformat(),
            "git": _git_sha(),
            "machine": {
                "python": platform.python_version(),
                "torch": torch.__version__,
                "cpu": os.cpu_count(),
                "device": "cpu",
            },
            "budget": self.budget.__dict__ | {"federated_tasks": list(self.budget.federated_tasks)},
            "synthetic": bool(agents and agents[0]["summary"]["synthetic"]),
            "mbs": mbs(scores),
            "mbs_linear": mbs({a["task"]: a["linear"]["score"] for a in agents}),
            "agents": agents,
            "federated": fed,
            "memory": {"size": len(self.memory), "records": self.memory.records()[-20:]},
            "task_info": {k: TASK_INFO.get(k, {}) for k in self.tasks},
            "seconds": round(time.perf_counter() - start, 1),
        }


def load_model(task_name: str, home: Path | None = None) -> tuple[torch.nn.Module, dict[str, Any]] | None:
    """Wczytuje zapisany model agenta (do API/MQTT) bez ładowania zbioru danych."""
    p = (home or ai_home()) / "models" / f"{task_name}.pt"
    if not p.exists():
        return None
    ck = torch.load(p, weights_only=False)  # noqa: S614 – własne pliki agentów
    z = np.zeros((1, *ck["input_shape"]), dtype=np.float32)
    shell = TaskData(task_name, ck["kind"], ck["input_kind"], z, z[:0], z, z[:0], z, z[:0], n_classes=ck["n_classes"])
    m = build_model(ModelSpec.from_dict(ck["spec"]), shell, seed=None)
    m.load_state_dict(ck["state"])
    m.eval()
    return m, ck
