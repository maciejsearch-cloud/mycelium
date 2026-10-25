"""Trening lokalny i ewaluacja (CPU). Wspólne dla agentów, federacji i orkiestratora."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
import torch
from torch import nn

from iot_mycelium.ai.datasets import TaskData


@dataclass
class TrainConfig:
    epochs: int = 5
    lr: float = 1e-3
    batch_size: int = 64
    weight_decay: float = 1e-4
    prox_mu: float = 0.0  # FedProx: kara μ/2·||w − w_global||²
    seed: int = 0
    max_seconds: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


def set_threads(n: int | None = None) -> None:
    torch.set_num_threads(n or max(1, min(8, torch.get_num_threads())))


def _tensors(task: TaskData, X: np.ndarray, y: np.ndarray) -> tuple[torch.Tensor, torch.Tensor]:
    xt = torch.from_numpy(np.ascontiguousarray(X))
    yt = torch.from_numpy(np.ascontiguousarray(y))
    if task.kind == "forecasting":
        yt = yt.float().view(-1, 1)
    return xt, yt


def loss_fn(task: TaskData) -> nn.Module:
    return nn.CrossEntropyLoss() if task.kind == "classification" else nn.MSELoss()


def train_model(
    model: nn.Module,
    task: TaskData,
    X: np.ndarray,
    y: np.ndarray,
    cfg: TrainConfig,
    global_params: list[torch.Tensor] | None = None,
    on_epoch: Callable[[int, float], None] | None = None,
) -> dict[str, Any]:
    """Trenuje ``model`` w miejscu (AdamW, mini-batch). Zwraca historię strat i czas."""
    gen = torch.Generator().manual_seed(cfg.seed)
    xt, yt = _tensors(task, X, y)
    opt = torch.optim.AdamW(model.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)
    crit = loss_fn(task)
    n = len(xt)
    losses: list[float] = []
    start = time.perf_counter()
    model.train()
    for epoch in range(cfg.epochs):
        perm = torch.randperm(n, generator=gen)
        total = 0.0
        for i in range(0, n, cfg.batch_size):
            idx = perm[i : i + cfg.batch_size]
            if len(idx) < 2 and n >= 2:
                continue
            opt.zero_grad(set_to_none=True)
            loss = crit(model(xt[idx]), yt[idx])
            if cfg.prox_mu > 0 and global_params is not None:
                prox = sum(((p - g) ** 2).sum() for p, g in zip(model.parameters(), global_params))
                loss = loss + cfg.prox_mu / 2 * prox
            loss.backward()
            opt.step()
            total += float(loss.detach()) * len(idx)
        losses.append(total / max(n, 1))
        if on_epoch:
            on_epoch(epoch, losses[-1])
        if cfg.max_seconds and time.perf_counter() - start > cfg.max_seconds:
            break
    return {"losses": losses, "seconds": time.perf_counter() - start, "samples": n * len(losses)}


@torch.no_grad()
def predict(model: nn.Module, X: np.ndarray, batch_size: int = 2048) -> np.ndarray:
    model.eval()
    outs = [model(torch.from_numpy(np.ascontiguousarray(X[i : i + batch_size]))) for i in range(0, len(X), batch_size)]
    return torch.cat(outs).numpy() if outs else np.zeros((0,))


def macro_f1(y_true: np.ndarray, y_pred: np.ndarray, n_classes: int) -> float:
    f1s = []
    for c in range(n_classes):
        tp = np.sum((y_pred == c) & (y_true == c))
        fp = np.sum((y_pred == c) & (y_true != c))
        fn = np.sum((y_pred != c) & (y_true == c))
        if tp + fp + fn == 0:
            continue
        f1s.append(2 * tp / (2 * tp + fp + fn))
    return float(np.mean(f1s)) if f1s else 0.0


def evaluate(model: nn.Module, task: TaskData, X: np.ndarray, y: np.ndarray) -> dict[str, float]:
    """Metryki na danych, których model nie widział.

    Klasyfikacja: accuracy, macro-F1 i ``score`` = accuracy znormalizowane względem losowania
    (0 = poziom losowy, 1 = ideał). Prognoza: RMSE/MAE w jednostkach standaryzowanych oraz
    ``score`` = skill względem prognozy naiwnej (persistence: następny = ostatni odczyt).
    """
    out = predict(model, X)
    if task.kind == "classification":
        pred = out.argmax(1)
        acc = float((pred == y).mean())
        chance = 1.0 / task.n_classes
        return {
            "accuracy": acc,
            "macro_f1": macro_f1(y, pred, task.n_classes),
            "score": max(0.0, (acc - chance) / (1 - chance)),
            "n": int(len(y)),
        }
    pred = out.reshape(-1)
    err = pred - y
    rmse = float(np.sqrt(np.mean(err**2)))
    naive = float(np.sqrt(np.mean((X[:, -1] - y) ** 2)))
    return {
        "rmse": rmse,
        "mae": float(np.mean(np.abs(err))),
        "naive_rmse": naive,
        "score": max(0.0, 1.0 - rmse / naive) if naive > 0 else 0.0,
        "n": int(len(y)),
    }


def get_params(model: nn.Module) -> list[torch.Tensor]:
    return [p.detach().clone() for p in model.parameters()]


def get_state(model: nn.Module) -> dict[str, torch.Tensor]:
    return {k: v.detach().clone() for k, v in model.state_dict().items()}
