"""Źródła pomiarów SelfModelu – zamieniają prawdziwe wyniki na :class:`Measurement` (bez wartości zastępczych).

* stały test LM (2000 pytań wyboru definicji, ``eval.bin``): wyniki opcji każdego pytania z modelu,
* pytania próbne samouka (``myc_lm_curriculum``; ``measured.items`` = rozkład na opcjach każdego pytania),
* testy szkolne czystej grzybni (``data/szkolne/wyniki.json`` – ostatni przebieg, z „nie wiem”).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

from .base import EvidenceSource, Measurement
from .calibration import TemperatureCalibrator, argmax, evaluate, split_half

LM_SUBJECT = "LM v{v} (Qwen2.5-0.5B + LoRA grzybni)"
CZYSTA_SUBJECT = "czysta grzybnia (reguły + rozbiór v3, bez modelu)"


def calibrate_domain(logits: Sequence[Sequence[float]], answers: Sequence[int], source: str) -> dict[str, Any]:
    """Temperatura dopasowana na parzystych pytaniach domeny, ocena (ECE przed/po) na nieparzystych."""
    fit, held = split_half(len(logits))
    cal = TemperatureCalibrator()
    cal.fit([logits[i] for i in fit], [answers[i] for i in fit], source=source)
    rep = evaluate([logits[i] for i in held], [answers[i] for i in held], cal)
    return {**rep, "params": cal.params(), "n_held_out": len(held), "held_out": "nieparzyste pytania (1, 3, 5 …)"}


def _cal_fields(rep: dict[str, Any]) -> dict[str, Any]:
    return dict(conf_raw=round(rep["conf_raw"], 4), conf_cal=round(rep["conf_cal"], 4), ece_raw=round(rep["ece_raw"], 4),
                ece_cal=round(rep["ece_cal"], 4), conf_n=rep["n"], conf_correct=rep["correct"],
                temperature=rep["params"]["T"])  # fmt: skip


def lm_eval_measurement(
    scores: Sequence[Sequence[float]], answers: Sequence[int], version: int, eval_sha: str, at: str
) -> tuple[Measurement, dict[str, Any]]:
    """Domena ``lm/definicje``: liczności z całego testu; temperatura z parzystych, pewność i ECE z nieparzystych."""
    if len(scores) != len(answers) or not scores:
        raise ValueError("wyniki i odpowiedzi muszą mieć tę samą, niezerową długość")
    correct = sum(argmax(s) == a for s, a in zip(scores, answers, strict=True))
    rep = calibrate_domain(scores, answers, "lm-eval-2000 (parzyste pytania)")
    m = Measurement(domain="lm/definicje", source="lm-eval-2000", subject=LM_SUBJECT.format(v=version),
                    n=len(scores), correct=correct, wrong=len(scores) - correct,
                    evidence=f"lm-v{version}|{eval_sha[:16]}", measured_at=at, chance=1 / len(scores[0]),
                    **_cal_fields(rep))  # fmt: skip
    return m, rep


def _log(p: float) -> float:
    return math.log(max(1e-6, p))


def samouk_measurements(plan: dict[str, Any], items: dict[str, list] | None) -> tuple[list[Measurement], dict]:
    """Domeny ``lm/<typ>`` z planu samouka. ``items[typ]`` = ``[[p_opcji…], poprawna]`` dla każdego pytania próbnego.

    Każdy typ ma własną temperaturę (parzyste pytania) i ECE na nieparzystych – przy 40 pytaniach to tylko 20 na
    ocenę, więc przedziały są szerokie (i tak je pokazujemy). Bez ``items`` (starsze plany) – tylko liczności.
    Zwraca też raporty kalibracji typów.
    """
    out, reps = [], {}
    version = plan["measured"]["base"]["version"]
    probe = plan["measured"].get("probe_sha") or ""
    for t, s in sorted(plan["stats"].items()):
        n = int(s["n"])
        ev = f"lm-v{version}|probe-{probe[:16]}"
        common = dict(domain=f"lm/{t}", source="samouk-probe", subject=LM_SUBJECT.format(v=version), n=n,
                      evidence=ev, measured_at=plan["at"])  # fmt: skip
        its = (items or {}).get(t)
        if its:
            lg = [[_log(p) for p in ps] for ps, _ in its]
            ans = [int(a) for _, a in its]
            if len(lg) != n:
                raise ValueError(f"{t}: {len(lg)} pytań w items, a n = {n}")
            k = sum(argmax(x) == a for x, a in zip(lg, ans, strict=True))
            rep = calibrate_domain(lg, ans, f"samouk {t} (parzyste pytania)")
            reps[f"lm/{t}"] = rep
            out.append(Measurement(**common, correct=k, wrong=n - k, chance=1 / len(lg[0]), **_cal_fields(rep)))
        else:
            k = round(float(s["acc"]) * n)
            out.append(Measurement(**common, correct=k, wrong=n - k, chance=0.25))
    return out, reps


def school_measurements(wyniki: dict[str, Any]) -> list[Measurement]:
    """Domeny ``czysta/klasa-<g>`` i ``czysta/wszystkie`` z ostatniego przebiegu testów szkolnych."""
    runs = wyniki.get("runs") or []
    if not runs:
        return []
    r = runs[-1]
    ev = f"{wyniki.get('set')}|{(wyniki.get('sha256') or '')[:16]}|{r['when']}"
    rows = [("wszystkie", {k: r[k] for k in ("n", "ok", "zle", "nie_wiem")})] + sorted(
        (r.get("per_grade") or {}).items()
    )
    return [
        Measurement(
            domain=f"czysta/klasa-{g}" if g != "wszystkie" else "czysta/wszystkie",
            source=str(wyniki.get("set")),
            subject=CZYSTA_SUBJECT,
            n=int(x["n"]),
            correct=int(x["ok"]),
            wrong=int(x["zle"]),
            abstained=int(x["nie_wiem"]),
            evidence=ev,
            measured_at=r["when"],
            url=r.get("url"),
        )  # fmt: skip
        for g, x in rows
    ]


class StaticSource(EvidenceSource):
    """Opakowanie gotowej listy pomiarów (np. policzonych przez skrypt) w interfejs :class:`EvidenceSource`."""

    def __init__(self, name: str, measurements: Sequence[Measurement]) -> None:
        self.name = name
        self._m = list(measurements)

    def collect(self) -> list[Measurement]:
        return list(self._m)
