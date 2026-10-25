"""Wspólna pamięć wektorowa grzybni: agenci zapisują doświadczenia jako wektory i odpytują sąsiadów.

Rekord = wektor (np. odcisk zadania z :func:`task_embedding`) + metadane (architektura,
hiperparametry, wynik). Wyszukiwanie: podobieństwo kosinusowe (NumPy, dokładne – przy tysiącach
rekordów szybsze niż indeks przybliżony). Trwałość: ``memory.npz`` + ``memory.jsonl``.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import numpy as np

from .datasets import TaskData

EMBED_DIM = 16


def task_embedding(task: TaskData) -> np.ndarray:
    """Meta-cechy zadania (bez etyket testowych) → wektor o stałej długości, znormalizowany."""
    x = task.X_train.reshape(len(task.X_train), -1).astype(np.float32)
    sample = x[: min(len(x), 2000)]
    kinds = ["tabular", "image", "text", "sequence"]
    v = [
        float(task.kind == "classification"),
        *[float(task.input_kind == k) for k in kinds],
        np.log1p(len(x)) / 12,
        np.log1p(x.shape[1]) / 8,
        np.log1p(task.n_classes) / 6,
        float(np.tanh(sample.mean())),
        float(np.tanh(sample.std())),
        float((sample == 0).mean()),
    ]
    if task.kind == "classification" and task.n_classes:
        p = np.bincount(task.y_train.astype(int), minlength=task.n_classes) / len(task.y_train)
        v += [float(-(p[p > 0] * np.log(p[p > 0])).sum() / np.log(task.n_classes)), float(p.max())]
    else:
        y = task.y_train.astype(np.float32)
        v += [float(np.tanh(y.std())), float(np.tanh(np.corrcoef(x[:2000, -1], y[:2000])[0, 1]))]
    v += [0.0] * (EMBED_DIM - len(v))
    a = np.asarray(v[:EMBED_DIM], dtype=np.float32)
    return a / (np.linalg.norm(a) + 1e-9)


class VectorMemory:
    def __init__(self, path: str | Path | None = None, dim: int = EMBED_DIM, load: bool = True):
        self.path = Path(path) if path else None
        self.dim = dim
        self._vecs = np.zeros((0, dim), dtype=np.float32)
        self._meta: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        if load and self.path and (self.path / "memory.npz").exists():
            self._vecs = np.load(self.path / "memory.npz")["vecs"]
            self._meta = [json.loads(line) for line in (self.path / "memory.jsonl").read_text().splitlines() if line]

    def __len__(self) -> int:
        return len(self._meta)

    def add(self, vector: np.ndarray, meta: dict[str, Any]) -> int:
        v = np.asarray(vector, dtype=np.float32).reshape(-1)
        if v.shape[0] != self.dim:
            raise ValueError(f"wektor ma {v.shape[0]} wymiarów, pamięć {self.dim}")
        v = v / (np.linalg.norm(v) + 1e-9)
        with self._lock:
            self._vecs = np.vstack([self._vecs, v[None]])
            self._meta.append(dict(meta))
            return len(self._meta) - 1

    def search(self, vector: np.ndarray, k: int = 3, where: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Top-k rekordów wg kosinusa; ``where`` filtruje po równości metadanych."""
        if not self._meta:
            return []
        q = np.asarray(vector, dtype=np.float32).reshape(-1)
        q = q / (np.linalg.norm(q) + 1e-9)
        sims = self._vecs @ q
        order = np.argsort(-sims)
        out = []
        for i in order:
            m = self._meta[i]
            if where and any(m.get(a) != b for a, b in where.items()):
                continue
            out.append({**m, "similarity": float(sims[i]), "id": int(i)})
            if len(out) == k:
                break
        return out

    def records(self) -> list[dict[str, Any]]:
        return [dict(m, id=i) for i, m in enumerate(self._meta)]

    def save(self) -> None:
        if not self.path:
            return
        self.path.mkdir(parents=True, exist_ok=True)
        with self._lock:
            np.savez(self.path / "memory.npz", vecs=self._vecs)
            (self.path / "memory.jsonl").write_text(
                "".join(json.dumps(m, ensure_ascii=False, default=str) + "\n" for m in self._meta)
            )
