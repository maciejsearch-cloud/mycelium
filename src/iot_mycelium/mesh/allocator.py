"""Wybór ścieżek (etap S4): przydział mocy między typy zadań według zmierzonego zysku na jednostkę obliczeń.

Aktywny dopiero, gdy wszystkie etapy mapy rozwoju są oznaczone jako zrobione – wcześniej `weights` zwraca przydział
równy. Zysk = zweryfikowana poprawa metryki wersji przyjętych przez bramkę (np. LM: przyrost poprawnych odpowiedzi
na 2000 pytań), koszt = FLOPs zapisane przy wynikach (myc_results.flops). Bramka i zbiór testowy są poza zasięgiem:
przydzielana jest tylko kolejność pracy w ramach mocy, którą udostępnili użytkownicy.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

MIN_SHARE = 0.05  # eksploracja: każdy typ dostaje co najmniej 5% rund


@dataclass(frozen=True)
class Gain:
    task: str
    delta: float  # zweryfikowana poprawa (≥ 0; regresje nie przechodzą bramki)
    pflops: float  # koszt w PFLOP


def weights(tasks: list[str], gains: list[Gain], stages_done: bool) -> dict[str, float]:
    """Udział każdego typu zadania (suma 1). Brak danych albo nieukończone etapy → po równo."""
    if not tasks:
        return {}
    eq = {t: 1 / len(tasks) for t in tasks}
    if not stages_done:
        return eq
    eff: dict[str, float] = {}
    for t in tasks:
        g = [x for x in gains if x.task == t and x.pflops > 0]
        if g:
            eff[t] = max(0.0, sum(x.delta for x in g)) / sum(x.pflops for x in g)
    if not eff or sum(eff.values()) <= 0:
        return eq
    # typy bez pomiaru: średnia z mierzonych (nie karzemy za brak danych)
    mean = sum(eff.values()) / len(eff)
    raw = {t: eff.get(t, mean) for t in tasks}
    tot = sum(raw.values())
    share = {t: raw[t] / tot for t in tasks}
    k = len(tasks)
    floor = min(MIN_SHARE, 1 / k)
    return {t: floor + (1 - floor * k) * share[t] for t in tasks}


def pick(w: dict[str, float], rng: random.Random) -> str:
    ts = sorted(w)
    return rng.choices(ts, weights=[w[t] for t in ts])[0]
