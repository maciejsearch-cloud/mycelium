"""Uczenie federacyjne agentów: każde urządzenie trenuje lokalnie, do grzybni trafiają tylko wagi.

- :func:`partition` – podział danych na klientów (naturalny: osoba/czujnik, albo non-IID Dirichlet),
- :func:`aggregate` – FedAvg (McMahan i in., 2017) z wagami ``liczba próbek`` lub ``próbki × jakość``,
- FedProx (Li i in., 2020) przez ``prox_mu`` w :class:`~iot_mycelium.ai.training.TrainConfig`,
- DP: obcięcie normy aktualizacji klienta + szum Gaussa na średniej (bez formalnego rachunku ε),
- secure aggregation: parami znoszące się maski – serwer widzi tylko zamaskowane aktualizacje.

Porównanie trzech reżimów (:func:`compare`): tylko lokalnie / federacyjnie / centralnie.
"""

from __future__ import annotations

import copy
import time
from dataclasses import dataclass
from typing import Any

import numpy as np
import torch
from torch import nn

from .datasets import TaskData
from .models import ModelSpec, build_model
from .training import TrainConfig, evaluate, get_params, train_model


@dataclass
class FedConfig:
    n_clients: int = 8
    rounds: int = 10
    local_epochs: int = 1
    fraction: float = 1.0  # odsetek klientów w rundzie
    weighting: str = "samples"  # "samples" | "quality"
    prox_mu: float = 0.0
    dp_clip: float = 0.0  # 0 = bez DP
    dp_noise: float = 0.0  # σ jako wielokrotność dp_clip
    secure_agg: bool = False
    partition: str = "natural"  # "natural" | "dirichlet"
    alpha: float = 0.5
    seed: int = 0

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


def partition(
    task: TaskData, n_clients: int, mode: str = "natural", alpha: float = 0.5, seed: int = 0
) -> list[np.ndarray]:
    """Indeksy próbek treningowych dla każdego klienta (bez pustych klientów)."""
    rng = np.random.default_rng(seed)
    n = len(task.y_train)
    if mode == "natural" and task.groups_train is not None:
        groups = np.unique(task.groups_train)
        rng.shuffle(groups)
        buckets = np.array_split(groups, min(n_clients, len(groups)))
        parts = [np.flatnonzero(np.isin(task.groups_train, b)) for b in buckets]
    elif task.kind == "classification":
        parts_l: list[list[int]] = [[] for _ in range(n_clients)]
        for c in range(task.n_classes):
            idx = np.flatnonzero(task.y_train == c)
            rng.shuffle(idx)
            cuts = (np.cumsum(rng.dirichlet([alpha] * n_clients)) * len(idx)).astype(int)[:-1]
            for k, chunk in enumerate(np.split(idx, cuts)):
                parts_l[k].extend(chunk.tolist())
        parts = [np.sort(np.array(p, dtype=np.int64)) for p in parts_l]
    else:
        parts = np.array_split(rng.permutation(n), n_clients)
    return [p for p in parts if len(p) >= 2]


def _flat(state: dict[str, torch.Tensor]) -> torch.Tensor:
    return torch.cat([v.reshape(-1).float() for v in state.values()])


def _unflat(vec: torch.Tensor, like: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    out, i = {}, 0
    for k, v in like.items():
        n = v.numel()
        out[k] = vec[i : i + n].reshape(v.shape).to(v.dtype)
        i += n
    return out


def _float_keys(state: dict[str, torch.Tensor]) -> list[str]:
    return [k for k, v in state.items() if v.is_floating_point()]


def pairwise_masks(n: int, dim: int, seed: int) -> list[torch.Tensor]:
    """Maski m_i = Σ_{j>i} r_ij − Σ_{j<i} r_ji; suma po klientach = 0 (secure aggregation)."""
    masks = [torch.zeros(dim) for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            r = torch.randn(dim, generator=torch.Generator().manual_seed(seed * 1_000_003 + i * 1009 + j)) * 10
            masks[i] += r
            masks[j] -= r
    return masks


def aggregate(
    global_state: dict[str, torch.Tensor],
    client_states: list[dict[str, torch.Tensor]],
    weights: list[float],
    dp_clip: float = 0.0,
    dp_noise: float = 0.0,
    secure_agg: bool = False,
    seed: int = 0,
) -> tuple[dict[str, torch.Tensor], dict[str, float]]:
    """Ważona średnia aktualizacji (Δ = w_klienta − w_globalne) dla tensorów zmiennoprzecinkowych."""
    keys = _float_keys(global_state)
    g = {k: global_state[k] for k in keys}
    g_vec = _flat(g)
    w = torch.tensor(weights, dtype=torch.float32)
    w = w / w.sum()
    deltas, clipped = [], 0
    for st in client_states:
        d = _flat({k: st[k] for k in keys}) - g_vec
        if dp_clip > 0:
            norm = float(d.norm())
            if norm > dp_clip:
                d = d * (dp_clip / norm)
                clipped += 1
        deltas.append(d)
    contrib = [wi * d for wi, d in zip(w, deltas)]
    if secure_agg:  # serwer sumuje tylko zamaskowane wektory
        masks = pairwise_masks(len(contrib), len(g_vec), seed)
        contrib = [c + m for c, m in zip(contrib, masks)]
    avg = torch.stack(contrib).sum(0)
    if dp_clip > 0 and dp_noise > 0:
        gen = torch.Generator().manual_seed(seed + 7)
        avg = avg + torch.randn(avg.shape, generator=gen) * dp_noise * dp_clip / len(deltas)
    new = dict(global_state)
    new.update(_unflat(g_vec + avg, g))
    # bufory całkowite (np. num_batches_tracked) – od pierwszego klienta
    for k, v in global_state.items():
        if not v.is_floating_point():
            new[k] = client_states[0][k].clone()
    return new, {"clipped": clipped, "update_norm": float(avg.norm())}


def _subset(task: TaskData, idx: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return task.X_train[idx], task.y_train[idx]


def federated_train(
    task: TaskData, spec: ModelSpec, fed: FedConfig, train: TrainConfig | None = None, eval_every: int = 1
) -> dict[str, Any]:
    """FedAvg/FedProx. Historia rund liczona na zbiorze walidacyjnym, wynik końcowy na testowym."""
    train = train or TrainConfig()
    rng = np.random.default_rng(fed.seed)
    parts = partition(task, fed.n_clients, fed.partition, fed.alpha, fed.seed)
    model = build_model(spec, task, seed=fed.seed)
    history, start, comm = [], time.perf_counter(), 0
    for r in range(fed.rounds):
        k = max(1, round(fed.fraction * len(parts)))
        chosen = sorted(rng.choice(len(parts), size=k, replace=False).tolist())
        g_state = {kk: v.detach().clone() for kk, v in model.state_dict().items()}
        g_params = get_params(model)
        states, weights, scores = [], [], []
        for c in chosen:
            local = copy.deepcopy(model)
            X, y = _subset(task, parts[c])
            cfg = TrainConfig(
                **{**train.to_dict(), "epochs": fed.local_epochs, "prox_mu": fed.prox_mu, "seed": fed.seed + r * 97 + c}
            )
            train_model(local, task, X, y, cfg, global_params=g_params if fed.prox_mu > 0 else None)
            st = local.state_dict()
            states.append(st)
            w = float(len(parts[c]))
            if fed.weighting == "quality":
                q = evaluate(local, task, task.X_val, task.y_val)["score"]
                scores.append(q)
                w *= max(q, 0.05)
            weights.append(w)
            comm += sum(t.numel() * t.element_size() for t in st.values()) * 2  # w dół + w górę
        new_state, info = aggregate(
            g_state, states, weights, fed.dp_clip, fed.dp_noise, fed.secure_agg, seed=fed.seed + r
        )
        model.load_state_dict(new_state)
        if (r + 1) % eval_every == 0 or r == fed.rounds - 1:
            history.append({"round": r + 1, "val": evaluate(model, task, task.X_val, task.y_val)["score"], **info})
    return {
        "model": model,
        "test": evaluate(model, task, task.X_test, task.y_test),
        "history": history,
        "clients": [int(len(p)) for p in parts],
        "seconds": time.perf_counter() - start,
        "comm_mb": comm / 1e6,
        "config": fed.to_dict(),
    }


def local_only(task: TaskData, spec: ModelSpec, fed: FedConfig, train: TrainConfig | None = None) -> dict[str, Any]:
    """Każdy agent uczy się sam na swoich danych (ten sam budżet epok co federacja)."""
    train = train or TrainConfig()
    parts = partition(task, fed.n_clients, fed.partition, fed.alpha, fed.seed)
    scores, start = [], time.perf_counter()
    for c, idx in enumerate(parts):
        m = build_model(spec, task, seed=fed.seed + c)
        X, y = _subset(task, idx)
        cfg = TrainConfig(**{**train.to_dict(), "epochs": fed.rounds * fed.local_epochs, "seed": fed.seed + c})
        train_model(m, task, X, y, cfg)
        scores.append(evaluate(m, task, task.X_test, task.y_test))
    key = "accuracy" if task.kind == "classification" else "rmse"
    return {
        "test": {
            "score": float(np.mean([s["score"] for s in scores])),
            key: float(np.mean([s[key] for s in scores])),
            "worst_score": float(np.min([s["score"] for s in scores])),
        },
        "seconds": time.perf_counter() - start,
    }


def centralized(
    task: TaskData, spec: ModelSpec, epochs: int, train: TrainConfig | None = None, seed: int = 0
) -> dict[str, Any]:
    """Górna granica: wszystkie dane w jednym miejscu (bez prywatności)."""
    train = train or TrainConfig()
    m = build_model(spec, task, seed=seed)
    r = train_model(
        m, task, task.X_train, task.y_train, TrainConfig(**{**train.to_dict(), "epochs": epochs, "seed": seed})
    )
    return {"model": m, "test": evaluate(m, task, task.X_test, task.y_test), "seconds": r["seconds"]}


def compare(task: TaskData, spec: ModelSpec, fed: FedConfig, train: TrainConfig | None = None) -> dict[str, Any]:
    """Lokalnie vs FedAvg vs FedProx vs FedAvg+ważenie jakością+DP+secure agg vs centralnie."""
    out: dict[str, Any] = {"task": task.name, "spec": spec.label(), "config": fed.to_dict()}
    out["local"] = local_only(task, spec, fed, train)
    runs = {
        "fedavg": fed,
        "fedprox": FedConfig(**{**fed.to_dict(), "prox_mu": 0.01}),
        "fed_private": FedConfig(
            **{**fed.to_dict(), "weighting": "quality", "dp_clip": 5.0, "dp_noise": 0.05, "secure_agg": True}
        ),
    }
    for name, cfg in runs.items():
        r = federated_train(task, spec, cfg, train)
        r.pop("model")
        out[name] = r
    c = centralized(task, spec, fed.rounds * fed.local_epochs, train, fed.seed)
    c.pop("model")
    out["centralized"] = c
    return out


def model_size(model: nn.Module) -> int:
    return sum(t.numel() * t.element_size() for t in model.state_dict().values())
