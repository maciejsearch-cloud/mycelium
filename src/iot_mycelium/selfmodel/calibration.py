"""Kalibracja pewności: temperatura dopasowana na jednej połowie pytań, ECE liczone na drugiej (odłożonej).

Wejście to „logity” opcji jednego pytania – dowolne wyniki, z których softmax daje rozkład (np. średni log-prob
odpowiedzi w stałym teście LM albo log p z ``option_probs`` samouka; softmax jest niezmienniczy względem przesunięcia).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

from .base import Calibrator

T_GRID = tuple(round(0.2 + 0.05 * i, 2) for i in range(197))  # 0,20 … 10,00


def softmax(x: Sequence[float], t: float = 1.0) -> list[float]:
    mx = max(x)
    e = [math.exp((v - mx) / t) for v in x]
    s = sum(e)
    return [v / s for v in e]


def argmax(x: Sequence[float]) -> int:
    return max(range(len(x)), key=lambda i: x[i])


def nll(logits: Sequence[Sequence[float]], answers: Sequence[int], t: float) -> float:
    """Średnia ujemna log-wiarygodność poprawnej odpowiedzi przy temperaturze t."""
    if not logits:
        raise ValueError("puste dane")
    return -sum(math.log(max(1e-12, softmax(lg, t)[a])) for lg, a in zip(logits, answers, strict=True)) / len(logits)


def ece(conf: Sequence[float], correct: Sequence[bool], bins: int = 10) -> float:
    """Expected calibration error: ważona liczbą pytań |trafność − pewność| w przedziałach pewności."""
    if not conf:
        raise ValueError("puste dane")
    groups: list[list[tuple[float, bool]]] = [[] for _ in range(bins)]
    for c, k in zip(conf, correct, strict=True):
        groups[min(bins - 1, int(c * bins))].append((c, k))
    n = len(conf)
    return sum(len(g) / n * abs(sum(k for _, k in g) / len(g) - sum(c for c, _ in g) / len(g)) for g in groups if g)


def reliability(conf: Sequence[float], correct: Sequence[bool], bins: int = 10) -> list[dict[str, float]]:
    """Tabela: przedział pewności → liczba pytań, średnia pewność, trafność (do wykresu na stronie)."""
    out = []
    for b in range(bins):
        g = [(c, k) for c, k in zip(conf, correct, strict=True) if min(bins - 1, int(c * bins)) == b]
        if g:
            out.append({"lo": b / bins, "n": len(g), "conf": sum(c for c, _ in g) / len(g), "acc": sum(k for _, k in g) / len(g)})  # fmt: skip
    return out


def split_half(n: int) -> tuple[list[int], list[int]]:
    """Stały podział: parzyste indeksy = dopasowanie, nieparzyste = ocena (bez losowości, powtarzalny)."""
    return list(range(0, n, 2)), list(range(1, n, 2))


class TemperatureCalibrator(Calibrator):
    """Jedna temperatura T dla softmaxu po opcjach; dopasowanie minimalizuje NLL (siatka 0,2–10)."""

    def __init__(self, t: float = 1.0) -> None:
        self.t = t
        self.n_fit = 0
        self.fit_source: str | None = None

    def fit(self, logits: Sequence[Sequence[float]], answers: Sequence[int], source: str | None = None) -> None:
        self.t = min(T_GRID, key=lambda t: nll(logits, answers, t))
        self.n_fit = len(logits)
        self.fit_source = source

    def probs(self, logits: Sequence[float]) -> list[float]:
        return softmax(logits, self.t)

    def params(self) -> dict[str, Any]:
        return {"method": "temperature", "T": self.t, "n_fit": self.n_fit, "fit_source": self.fit_source}


def evaluate(logits: Sequence[Sequence[float]], answers: Sequence[int], cal: Calibrator) -> dict[str, Any]:
    """Trafność, średnia pewność wybranej odpowiedzi i ECE – surowe (T = 1) i po kalibracji."""
    pick = [argmax(lg) for lg in logits]
    ok = [p == a for p, a in zip(pick, answers, strict=True)]
    raw = [softmax(lg)[p] for lg, p in zip(logits, pick, strict=True)]
    cal_c = [cal.probs(lg)[p] for lg, p in zip(logits, pick, strict=True)]
    return {
        "n": len(ok),
        "correct": sum(ok),
        "conf_raw": sum(raw) / len(raw),
        "conf_cal": sum(cal_c) / len(cal_c),
        "ece_raw": ece(raw, ok),
        "ece_cal": ece(cal_c, ok),
        "reliability_raw": reliability(raw, ok),
        "reliability_cal": reliability(cal_c, ok),
    }
