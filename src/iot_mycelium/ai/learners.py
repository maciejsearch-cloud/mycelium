"""Małe modele węzłów (te same cechy i algorytm co w przeglądarce: web/src/myc/models.ts).

* intencje: hashowany worek słów (+ bigramy) → regresja softmax,
* anomalie czujnika: 10 cech (kształt względem kontekstu + poziom) okna względem 24 h kontekstu → regresja logistyczna,
* „specjaliści”: binarne modele jeden-kontra-reszta dla słabych klas, dosypywane do
  logitów głównego modelu (grzybnia może je tworzyć i usuwać sama).
"""

from __future__ import annotations

import re

import numpy as np

YN = ["tak", "nie"]


def fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode():
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def text_features(texts: list[str], dim: int, bigrams: bool) -> np.ndarray:
    x = np.zeros((len(texts), dim + 1), dtype=np.float64)
    for i, t in enumerate(texts):
        toks = re.findall(r"[a-z0-9']+", t.lower())
        grams = toks + ([f"{a}_{b}" for a, b in zip(toks, toks[1:], strict=False)] if bigrams else [])
        for g in grams:
            x[i, fnv1a(g) % dim] += 1.0
        n = np.linalg.norm(x[i, :dim])
        if n:
            x[i, :dim] /= n
        x[i, dim] = 1.0
    return x


def sensor_features(items: list[dict]) -> np.ndarray:
    rows = []
    for it in items:
        seg, ctx = np.asarray(it["seg"], float), np.asarray(it["ctx"], float)
        mu, sd = ctx.mean(), ctx.std() + 1e-3
        z = (seg - mu) / sd
        slope = np.polyfit(np.arange(len(seg)), z, 1)[0] * len(seg)
        rows.append(
            [
                z.mean(),
                z.min(),
                z.max(),
                seg.std() / sd,
                slope,
                z[-1] - z[0],
                np.abs(np.diff(seg)).mean() / sd,
                (seg.max() - seg.min()) / sd,
                (seg.mean() - 85) / 10,
                (seg.min() - 85) / 10,
                1.0,
            ]
        )
    return np.asarray(rows)


def train_softmax(
    x: np.ndarray, y: np.ndarray, k: int, lr: float, l2: float, epochs: int, class_weight: np.ndarray | None = None
) -> np.ndarray:
    w = np.zeros((x.shape[1], k))
    onehot = np.eye(k)[y]
    sw = (class_weight[y] if class_weight is not None else np.ones(len(y)))[:, None]
    m, v = np.zeros_like(w), np.zeros_like(w)
    for t in range(1, epochs + 1):  # Adam, pełny batch – deterministycznie
        logits = x @ w
        logits -= logits.max(1, keepdims=True)
        p = np.exp(logits)
        p /= p.sum(1, keepdims=True)
        g = x.T @ ((p - onehot) * sw) / sw.sum() + l2 * w
        m = 0.9 * m + 0.1 * g
        v = 0.999 * v + 0.001 * g * g
        w -= lr * (m / (1 - 0.9**t)) / (np.sqrt(v / (1 - 0.999**t)) + 1e-8)
    return w


def softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(1, keepdims=True)


DEFAULT_CONFIG = {
    "intent": {"dim": 512, "bigrams": False, "lr": 0.05, "l2": 1e-3, "epochs": 150, "min_conf": 0.7, "specialists": []},
    "sensor": {"lr": 0.05, "l2": 1e-3, "epochs": 200, "pos_weight": 3.0, "threshold": 0.5, "min_conf": 0.7},
}


class IntentAgent:
    def __init__(self, cfg: dict, labels: list[str]):
        self.cfg, self.labels = cfg, labels

    def fit(self, texts: list[str], y: list[int]) -> IntentAgent:
        c, k = self.cfg, len(self.labels)
        x = text_features(texts, c["dim"], c["bigrams"])
        yy = np.asarray(y)
        self.w = train_softmax(x, yy, k, c["lr"], c["l2"], c["epochs"])
        self.spec = {}
        for cls in c["specialists"]:
            self.spec[cls] = train_softmax(
                x, (yy == cls).astype(int), 2, c["lr"], c["l2"], c["epochs"], np.array([1.0, 3.0])
            )
        return self

    def proba(self, texts: list[str]) -> np.ndarray:
        x = text_features(texts, self.cfg["dim"], self.cfg["bigrams"])
        z = x @ self.w
        for cls, w in self.spec.items():
            p = softmax(x @ w)[:, 1].clip(1e-4, 1 - 1e-4)
            z[:, cls] += np.log(p / (1 - p))
        return softmax(z)


class SensorAgent:
    def __init__(self, cfg: dict):
        self.cfg = cfg

    def fit(self, items: list[dict], y: list[int]) -> SensorAgent:
        x = sensor_features(items)
        self.mu, self.sd = x[:, :-1].mean(0), x[:, :-1].std(0) + 1e-6
        c = self.cfg
        self.w = train_softmax(
            self._norm(x), np.asarray(y), 2, c["lr"], c["l2"], c["epochs"], np.array([1.0, c["pos_weight"]])
        )
        return self

    def _norm(self, x: np.ndarray) -> np.ndarray:
        x = x.copy()
        x[:, :-1] = (x[:, :-1] - self.mu) / self.sd
        return x

    def proba(self, items: list[dict]) -> np.ndarray:
        """Prawdopodobieństwo anomalii (klasa 1)."""
        return softmax(self._norm(sensor_features(items)) @ self.w)[:, 1]


def balanced_acc(y: np.ndarray, pred: np.ndarray) -> float:
    accs = [float((pred[y == c] == c).mean()) for c in np.unique(y)]
    return float(np.mean(accs))
