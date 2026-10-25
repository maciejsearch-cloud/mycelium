"""Mycelium Benchmark Score (MBS) – następca „IQ”, liczony wyłącznie na zbiorach testowych.

Dla klasyfikacji: dokładność znormalizowana względem losowania (0 = zgadywanie, 1 = ideał).
Dla prognoz: skill względem prognozy naiwnej (0 = nie lepiej niż „jak ostatnio”).
MBS = średnia × 100, więc 0–100.
"""

from __future__ import annotations

from collections.abc import Mapping


def mbs(task_scores: Mapping[str, float]) -> float:
    vals = [max(0.0, min(1.0, float(v))) for v in task_scores.values()]
    return round(100 * sum(vals) / len(vals), 2) if vals else 0.0
