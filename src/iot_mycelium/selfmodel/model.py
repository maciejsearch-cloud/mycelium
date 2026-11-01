"""Implementacja SelfModelu: twierdzenia wyprowadzone z pomiarów i kontrola spójności z kolejnymi pomiarami.

Reguły twierdzeń (wszystkie z liczbą, przedziałem 95% Wilsona i n):

* ``poziom`` (LM): trafność wobec zgadywania – „niska” gdy dolna granica przedziału ≤ zgadywanie (nie odróżnia się
  od zgadywania), „nieco lepsza” gdy dolna granica < zgadywanie + 10 pkt, inaczej „lepsza niż zgadywanie”.
* ``kalibracja`` (LM): średnia skalibrowana pewność; przewidywanie = trafność w przedziale pewność ± 1,96·SE.
* ``precyzja`` / ``nie_wiem`` (czysta grzybnia): trafność udzielonych odpowiedzi i odsetek „nie wiem”.
* ``stan``: z czego się składam i czego teraz się uczę (z planu samouka) – bez kontroli liczbowej.

Kontrola (:meth:`MeasuredSelfModel.check`):

1. twierdzenia z poprzedniej migawki kontra bieżący pomiar tej samej domeny – zgodne, gdy przedział
   twierdzenia i przedział nowego pomiaru się przecinają; ten sam odcisk danych = ``brak_nowych_danych``;
2. w każdej migawce: deklarowana pewność (surowa i skalibrowana) kontra rzeczywista trafność na danych
   odłożonych – zgodne, gdy pewność leży w przedziale 95% trafności.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from .base import Check, Claim, ClaimKind, Decision, Measurement, SelfModel, Snapshot, Verdict, wilson

LEVEL_MARGIN = 0.10
MIN_N = 10

DOMAIN_PL = {
    "definicje": "definicje słów (2000 pytań)",
    "logika": "logika",
    "matematyka": "matematyka",
    "przypadki": "przypadki",
    "role": "role w zdaniu",
    "wszystkie": "wszystkie klasy",
}
DOMAIN_EN = {
    "definicje": "word definitions (2000 questions)",
    "logika": "logic",
    "matematyka": "maths",
    "przypadki": "grammatical cases",
    "role": "sentence roles",
    "wszystkie": "all grades",
}


def _name(domain: str, en: bool) -> str:
    key = domain.split("/", 1)[1]
    if key.startswith("klasa-"):
        g = key[6:]
        return f"grade {g}" if en else f"klasa {g}"
    return (DOMAIN_EN if en else DOMAIN_PL).get(key, key)


def _pct(x: float) -> str:
    return f"{x * 100:.1f}".replace(".0", "") + "%"


def _ci(lo: float, hi: float) -> str:
    return f"{lo * 100:.0f}–{hi * 100:.0f}%"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _overlap(a: tuple[float, float], b: tuple[float, float]) -> bool:
    return a[0] <= b[1] and b[0] <= a[1]


def claims_for(m: Measurement, at: str) -> list[Claim]:
    """Twierdzenia wynikające z jednego pomiaru (pusta lista przy n < MIN_N – za mało, by cokolwiek twierdzić)."""
    if m.n < MIN_N:
        return []
    pl, en = _name(m.domain, False), _name(m.domain, True)
    base = dict(domain=m.domain, n=m.n, source=m.source, evidence=m.evidence, made_at=at)
    out: list[Claim] = []
    if m.chance is not None:
        lo, hi = m.accuracy_ci()
        c = m.chance
        num_pl = f"trafiam {_pct(m.accuracy)} ({m.correct}/{m.n}, 95%: {_ci(lo, hi)}), zgadywanie daje {_pct(c)}"
        num_en = f"I get {_pct(m.accuracy)} right ({m.correct}/{m.n}, 95%: {_ci(lo, hi)}); guessing gives {_pct(c)}"
        if lo <= c:
            t_pl = f"Moja pewność w domenie „{pl}” jest niska: {num_pl} – nie odróżniam się jeszcze od zgadywania."
            t_en = f"My confidence in “{en}” is low: {num_en} – I can't yet be told apart from guessing."
        elif lo < c + LEVEL_MARGIN:
            t_pl = f"W domenie „{pl}” jestem nieco lepsza niż zgadywanie: {num_pl}."
            t_en = f"In “{en}” I am slightly better than guessing: {num_en}."
        else:
            t_pl, t_en = (
                f"W domenie „{pl}” jestem lepsza niż zgadywanie: {num_pl}.",
                f"In “{en}” I beat guessing: {num_en}.",
            )
        out.append(Claim(id=f"poziom:{m.domain}", kind=ClaimKind.LEVEL, text_pl=t_pl, text_en=t_en, value=m.accuracy,
                         low=lo, high=hi, **base))  # fmt: skip
        if m.conf_cal is not None:
            se = math.sqrt(max(1e-9, m.conf_cal * (1 - m.conf_cal)) / m.n)
            lo2, hi2 = max(0.0, m.conf_cal - 1.96 * se), min(1.0, m.conf_cal + 1.96 * se)
            out.append(Claim(
                id=f"kalibracja:{m.domain}", kind=ClaimKind.CALIBRATION, value=m.conf_cal, low=lo2, high=hi2,
                text_pl=(f"W domenie „{pl}” moja skalibrowana pewność wynosi średnio {_pct(m.conf_cal)} "
                         f"(bez kalibracji {_pct(m.conf_raw or 0)}); przewiduję trafność {_ci(lo2, hi2)}."),
                text_en=(f"In “{en}” my calibrated confidence averages {_pct(m.conf_cal)} "
                         f"(uncalibrated {_pct(m.conf_raw or 0)}); I predict accuracy of {_ci(lo2, hi2)}."),
                **base))  # fmt: skip
    else:
        if m.answered >= MIN_N and m.precision is not None:
            lo, hi = m.precision_ci()
            out.append(Claim(
                id=f"precyzja:{m.domain}", kind=ClaimKind.PRECISION, value=m.precision, low=lo, high=hi,
                text_pl=(f"Gdy w zadaniach „{pl}” odpowiadam, mam rację w {_pct(m.precision)} "
                         f"({m.correct}/{m.answered}, 95%: {_ci(lo, hi)})."),
                text_en=(f"When I answer in “{en}”, I am right {_pct(m.precision)} of the time "
                         f"({m.correct}/{m.answered}, 95%: {_ci(lo, hi)})."),
                **base))  # fmt: skip
        lo, hi = wilson(m.abstained, m.n)
        out.append(Claim(
            id=f"nie_wiem:{m.domain}", kind=ClaimKind.ABSTENTION, value=m.abstain_rate, low=lo, high=hi,
            text_pl=f"W zadaniach „{pl}” mówię „nie wiem” w {_pct(m.abstain_rate)} przypadków ({m.abstained}/{m.n}).",
            text_en=f"In “{en}” I say “I don't know” in {_pct(m.abstain_rate)} of cases ({m.abstained}/{m.n}).",
            **base))  # fmt: skip
    return out


def _observed(kind: ClaimKind, m: Measurement) -> tuple[float | None, tuple[float, float] | None, int]:
    """Wartość i przedział 95% nowego pomiaru odpowiadające rodzajowi twierdzenia."""
    if kind in (ClaimKind.LEVEL, ClaimKind.CALIBRATION):
        return m.accuracy, m.accuracy_ci(), m.n
    if kind is ClaimKind.PRECISION:
        return m.precision, (m.precision_ci() if m.answered else None), m.answered
    if kind is ClaimKind.ABSTENTION:
        return m.abstain_rate, wilson(m.abstained, m.n), m.n
    return None, None, 0


def check_claims(previous: Sequence[Claim], current: Sequence[Measurement]) -> list[Check]:
    """Twierdzenia z poprzedniej migawki kontra bieżące pomiary (punkt 1 opisu modułu)."""
    by = {m.domain: m for m in current}
    out = []
    for c in previous:
        if c.kind is ClaimKind.STATE or c.low is None or c.high is None:
            continue
        m = by.get(c.domain)
        exp = (c.low, c.high)
        if m is None:
            out.append(Check(c.id, Verdict.INSUFFICIENT, None, *exp, 0, "", "brak bieżącego pomiaru tej domeny",
                             "no current measurement of this domain"))  # fmt: skip
            continue
        val, ci, n = _observed(c.kind, m)
        if m.evidence == c.evidence:
            out.append(Check(c.id, Verdict.NO_NEW_EVIDENCE, val, *exp, n, m.evidence,
                             "te same dane co przy twierdzeniu – kontrola byłaby pozorna",
                             "same data as when the claim was made – a check would be meaningless"))  # fmt: skip
            continue
        if val is None or ci is None or n < MIN_N:
            out.append(Check(c.id, Verdict.INSUFFICIENT, val, *exp, n, m.evidence, f"n = {n} < {MIN_N}",
                             f"n = {n} < {MIN_N}"))  # fmt: skip
            continue
        ok = _overlap(exp, ci)
        v = Verdict.CONSISTENT if ok else Verdict.INCONSISTENT
        out.append(Check(c.id, v, val, *exp, n, m.evidence,
                         f"przewidywane {_ci(*exp)}, zmierzone {_pct(val)} (95%: {_ci(*ci)})",
                         f"predicted {_ci(*exp)}, measured {_pct(val)} (95%: {_ci(*ci)})"))  # fmt: skip
    return out


def check_confidence(current: Sequence[Measurement]) -> list[Check]:
    """Deklarowana pewność kontra trafność na danych odłożonych, w tej samej migawce (punkt 2 opisu modułu)."""
    out = []
    for m in current:
        if m.conf_raw is None or m.conf_cal is None or m.n < MIN_N:
            continue
        lo, hi = m.accuracy_ci()
        for tag, conf, e, name_pl, name_en in (
            ("surowa", m.conf_raw, m.ece_raw, "surowa pewność", "raw confidence"),
            ("skalibrowana", m.conf_cal, m.ece_cal, "skalibrowana pewność", "calibrated confidence"),
        ):
            ok = lo <= conf <= hi
            out.append(Check(
                f"pewnosc-{tag}:{m.domain}", Verdict.CONSISTENT if ok else Verdict.INCONSISTENT, m.accuracy, conf, conf,
                m.n, m.evidence,
                f"{name_pl} {_pct(conf)} vs trafność {_pct(m.accuracy)} (95%: {_ci(lo, hi)}), ECE {e:.3f}",
                f"{name_en} {_pct(conf)} vs accuracy {_pct(m.accuracy)} (95%: {_ci(lo, hi)}), ECE {e:.3f}"))  # fmt: skip
    return out


def decisions_from_plans(plans: Sequence[dict[str, Any]]) -> list[Decision]:
    """Przydziały zadań samouka (myc_lm_curriculum) i ich skutek zmierzony w następnym planie."""
    ps = sorted(plans, key=lambda p: p["id"])
    out = []
    for i, p in enumerate(ps):
        alloc = {k: int(v) for k, v in (p.get("alloc") or {}).items() if int(v) > 0}
        top = max(alloc, key=lambda k: alloc[k]) if alloc else None
        reason = ((p.get("why") or {}).get(top) or {}).get("reason", "") if top else ""
        nxt = ps[i + 1] if i + 1 < len(ps) else None
        outcome = pl = en = None
        if nxt:
            prog = {t: (nxt["stats"].get(t) or {}).get("progress") for t in alloc}
            cand = (nxt.get("measured") or {}).get("cand")
            outcome = {"plan": nxt["id"], "progress": prog, "cand": cand}
            parts = [f"{t} {v * 100:+.1f} pkt" for t, v in prog.items() if v is not None]
            parts_en = [f"{t} {v * 100:+.1f} pp" for t, v in prog.items() if v is not None]
            c_pl = f", kandydat #{cand['id']}: {cand.get('status')}" if cand else ", bez kandydata"
            c_en = f", candidate #{cand['id']}: {cand.get('status')}" if cand else ", no candidate"
            pl = f"zmierzone w planie #{nxt['id']}: " + (", ".join(parts) or "postęp nieznany") + c_pl
            en = f"measured in plan #{nxt['id']}: " + (", ".join(parts_en) or "progress unknown") + c_en
        out.append(Decision(id=f"plan-{p['id']}", at=p["at"], kind="samouk-alloc", choice=alloc, reason=reason,
                            outcome=outcome, outcome_pl=pl, outcome_en=en))  # fmt: skip
    return out


def state_claims(state: dict[str, Any], plan: dict[str, Any] | None, at: str) -> list[Claim]:
    """Twierdzenia o stanie: architektura (z myc_models) i bieżący przydział nauki (z planu samouka)."""
    out = []
    lm = state.get("lm")
    if lm:
        out.append(Claim(
            id="stan:lm", kind=ClaimKind.STATE, domain="lm", value=None, low=None, high=None, n=0,
            source="myc_models", evidence=f"lm-v{lm['version']}", made_at=at,
            text_pl=(f"Jestem modelem {lm['base']} z adapterem LoRA rank {lm['rank']} ({lm['params']:,} parametrów "
                     f"uczonych przez grzybnię), wersja v{lm['version']}.").replace(",", " "),
            text_en=(f"I am {lm['base']} with a rank-{lm['rank']} LoRA adapter ({lm['params']:,} parameters trained "
                     f"by the mycelium), version v{lm['version']}."),
        ))  # fmt: skip
    if plan and plan.get("alloc"):
        alloc = {k: int(v) for k, v in plan["alloc"].items()}
        total = sum(alloc.values()) + int(plan.get("wiki_jobs") or 0)
        top = max(alloc, key=lambda k: alloc[k])
        out.append(Claim(
            id="stan:nauka", kind=ClaimKind.STATE, domain="lm", value=alloc[top] / max(1, total), low=None, high=None,
            n=total, source="myc_lm_curriculum", evidence=f"plan-{plan['id']}", made_at=at,
            text_pl=f"Teraz uczę się głównie: {_name('lm/' + top, False)} ({alloc[top]}/{total} zadań rundy, plan #{plan['id']}).",
            text_en=f"Right now I mostly study: {_name('lm/' + top, True)} ({alloc[top]}/{total} jobs per round, plan #{plan['id']}).",
        ))  # fmt: skip
    return out


class MeasuredSelfModel(SelfModel):
    """SelfModel zbudowany wyłącznie z pomiarów i decyzji podanych z zewnątrz (bez własnych liczb)."""

    def __init__(self, state: dict[str, Any] | None = None, calibration: dict[str, Any] | None = None,
                 plan: dict[str, Any] | None = None, at: str | None = None,
                 relations: dict[str, Any] | None = None) -> None:  # fmt: skip
        self.state = state or {}
        self.calibration = calibration or {}
        self.plan = plan
        self.at = at or _now()
        self.relations = relations
        self._m: list[Measurement] = []
        self._d: list[Decision] = []
        self._checks: list[Check] | None = None

    def observe(self, measurements: Sequence[Measurement]) -> None:
        seen = {m.domain for m in self._m}
        for m in measurements:
            if m.domain in seen:
                raise ValueError(f"dwa pomiary domeny {m.domain}")
            seen.add(m.domain)
            self._m.append(m)

    def record(self, decisions: Sequence[Decision]) -> None:
        self._d.extend(decisions)

    def claims(self) -> list[Claim]:
        out = state_claims(self.state, self.plan, self.at)
        for m in self._m:
            out += claims_for(m, self.at)
        return out

    def check(self, previous: Snapshot | None) -> list[Check]:
        prev = check_claims(previous.claims, self._m) if previous else []
        self._checks = prev + check_confidence(self._m)
        return self._checks

    def fingerprint(self) -> str:
        """Odcisk wejść: pomiary (odciski danych + liczby), decyzje i kalibracja – bez czasu migawki."""
        key = {
            "m": sorted((m.domain, m.evidence, m.n, m.correct, m.wrong, m.abstained, m.conf_cal) for m in self._m),
            "d": [(d.id, json.dumps(d.outcome, sort_keys=True)) for d in self._d],
            "c": self.calibration.get("params"),
            "s": json.dumps(self.state, sort_keys=True),
            "r": json.dumps(self.relations, sort_keys=True),
        }
        return hashlib.sha256(json.dumps(key, sort_keys=True, default=str).encode()).hexdigest()[:32]

    def snapshot(self) -> Snapshot:
        checks = self._checks if self._checks is not None else self.check(None)
        return Snapshot(at=self.at, fingerprint=self.fingerprint(), state=self.state, measurements=list(self._m),
                        claims=self.claims(), checks=checks, decisions=list(self._d),
                        calibration=self.calibration, relations=self.relations)  # fmt: skip
