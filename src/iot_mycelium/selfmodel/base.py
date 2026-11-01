"""Interfejsy SelfModelu: pomiar → twierdzenie o sobie → kontrola spójności z kolejnym pomiarem.

Zasada: SelfModel nie zawiera żadnej liczby, której nie da się wskazać w pomiarze (źródło, n, odcisk danych).
Każde twierdzenie („moja pewność w domenie Y jest niska”) niesie wartość, przedział 95% i liczność próby, a przy
kolejnym pomiarze jest sprawdzane: zgodne / niezgodne / brak nowych danych / za mało danych.

Typy są niezmienne (``frozen``) i serializowalne do JSON (:meth:`Snapshot.to_json` / :meth:`Snapshot.from_json`),
bo migawka trafia do bazy (zapis tylko właściciel, odczyt publiczny) i na stronę.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from enum import Enum, StrEnum
from typing import Any

SCHEMA_VERSION = 1


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Przedział Wilsona (95%) dla odsetka k/n; (0, 1) gdy n = 0."""
    if n <= 0:
        return 0.0, 1.0
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


class Verdict(StrEnum):
    """Wynik kontroli jednego twierdzenia względem pomiaru."""

    CONSISTENT = "zgodne"
    INCONSISTENT = "niezgodne"
    NO_NEW_EVIDENCE = "brak_nowych_danych"  # ten sam odcisk danych co przy twierdzeniu – kontrola byłaby pozorna
    INSUFFICIENT = "za_malo_danych"  # brak pomiaru tej domeny albo n za małe


class ClaimKind(StrEnum):
    LEVEL = "poziom"  # trafność w domenie (np. blisko zgadywania)
    CALIBRATION = "kalibracja"  # „gdy jestem pewna na p, trafiam ≈ p”
    PRECISION = "precyzja"  # trafność odpowiedzi udzielonych (bez „nie wiem”)
    ABSTENTION = "nie_wiem"  # jak często odmawiam odpowiedzi
    STATE = "stan"  # co teraz robię / z czego się składam


@dataclass(frozen=True)
class Measurement:
    """Jeden zmierzony wynik w jednej domenie (np. ``lm/logika``, ``czysta/klasa-3``).

    ``evidence`` to odcisk danych (np. sha zbioru + wersja modelu): ten sam odcisk = te same dane.
    ``conf_raw``/``conf_cal`` – średnia pewność modelu dla wybranej odpowiedzi przed i po kalibracji (tylko LM).
    """

    domain: str
    source: str
    subject: str
    n: int
    correct: int
    wrong: int
    evidence: str
    measured_at: str
    abstained: int = 0
    chance: float | None = None
    conf_raw: float | None = None
    conf_cal: float | None = None
    ece_raw: float | None = None
    ece_cal: float | None = None
    url: str | None = None
    # pewność i ECE liczone na odłożonej połowie (``conf_n`` pytań, z tego ``conf_correct`` trafnych) przy
    # temperaturze ``temperature`` dopasowanej na drugiej połowie tej samej domeny (schemat 1, pola opcjonalne)
    conf_n: int | None = None
    conf_correct: int | None = None
    temperature: float | None = None

    def __post_init__(self) -> None:
        if self.n < 0 or self.correct < 0 or self.wrong < 0 or self.abstained < 0:
            raise ValueError("liczności nie mogą być ujemne")
        if self.correct + self.wrong + self.abstained != self.n:
            raise ValueError(f"{self.domain}: correct + wrong + abstained ≠ n")

    @property
    def accuracy(self) -> float:
        return self.correct / self.n if self.n else 0.0

    @property
    def answered(self) -> int:
        return self.correct + self.wrong

    @property
    def precision(self) -> float | None:
        """Trafność odpowiedzi udzielonych; None, gdy wszystko było „nie wiem”."""
        return self.correct / self.answered if self.answered else None

    @property
    def abstain_rate(self) -> float:
        return self.abstained / self.n if self.n else 0.0

    def accuracy_ci(self) -> tuple[float, float]:
        return wilson(self.correct, self.n)

    def held_out(self) -> tuple[int, int]:
        """(trafne, n) zbioru, na którym liczono pewność; bez osobnego zbioru – cały pomiar."""
        if self.conf_n:
            return int(self.conf_correct or 0), int(self.conf_n)
        return self.correct, self.n

    def precision_ci(self) -> tuple[float, float]:
        return wilson(self.correct, self.answered)


@dataclass(frozen=True)
class Claim:
    """Twierdzenie o sobie, wyprowadzone z pomiaru; ``[low, high]`` = co przewiduje dla kolejnego pomiaru."""

    id: str  # stabilne między migawkami: f"{kind}:{domain}"
    kind: ClaimKind
    domain: str
    text_pl: str
    text_en: str
    value: float | None
    low: float | None
    high: float | None
    n: int
    source: str
    evidence: str
    made_at: str


@dataclass(frozen=True)
class Check:
    """Kontrola spójności: twierdzenie z poprzedniej migawki kontra bieżący pomiar."""

    claim_id: str
    verdict: Verdict
    observed: float | None
    expected_low: float | None
    expected_high: float | None
    n: int
    evidence: str
    detail_pl: str
    detail_en: str


@dataclass(frozen=True)
class Decision:
    """Własna decyzja (np. przydział zadań samouka) i jej zmierzony skutek; ``outcome`` None = jeszcze nieznany."""

    id: str
    at: str
    kind: str
    choice: dict[str, int]
    reason: str
    outcome: dict[str, Any] | None = None
    outcome_pl: str | None = None
    outcome_en: str | None = None


@dataclass
class Snapshot:
    """Pełny stan SelfModelu w chwili ``at`` – to, co trafia do bazy i na stronę."""

    at: str
    fingerprint: str  # odcisk wszystkich wejść: bez zmian = nie zapisujemy nowej migawki
    state: dict[str, Any]
    measurements: list[Measurement]
    claims: list[Claim]
    checks: list[Check] = field(default_factory=list)
    decisions: list[Decision] = field(default_factory=list)
    calibration: dict[str, Any] = field(default_factory=dict)
    # punkt rozszerzenia „relacje” (pamięć relacji z użytkownikami, osobny moduł/tabela myc_self_relations):
    # w migawce tylko stan źródła ({source, available, public_rows}) – nigdy treść relacji z osobami
    relations: dict[str, Any] | None = None
    schema: int = SCHEMA_VERSION

    def to_json(self) -> dict[str, Any]:
        def enc(x: Any) -> Any:
            if isinstance(x, Enum):
                return x.value
            if isinstance(x, dict):
                return {k: enc(v) for k, v in x.items()}
            if isinstance(x, list | tuple):
                return [enc(v) for v in x]
            return x

        return enc(asdict(self))

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> Snapshot:
        if d.get("schema", 1) > SCHEMA_VERSION:
            raise ValueError(f"migawka w nowszym schemacie {d.get('schema')} (obsługiwany {SCHEMA_VERSION})")
        return cls(
            at=d["at"],
            fingerprint=d["fingerprint"],
            state=d.get("state") or {},
            measurements=[Measurement(**m) for m in d.get("measurements") or []],
            claims=[Claim(**{**c, "kind": ClaimKind(c["kind"])}) for c in d.get("claims") or []],
            checks=[Check(**{**c, "verdict": Verdict(c["verdict"])}) for c in d.get("checks") or []],
            decisions=[Decision(**x) for x in d.get("decisions") or []],
            calibration=d.get("calibration") or {},
            relations=d.get("relations"),
            schema=d.get("schema", SCHEMA_VERSION),
        )


# ---------------------------------------------------------------- interfejsy
class EvidenceSource(ABC):
    """Źródło prawdziwych pomiarów (testy samouka, testy szkolne czystej grzybni, stały test LM)."""

    name: str

    @abstractmethod
    def collect(self) -> list[Measurement]:
        """Zwraca pomiary; pusta lista = brak danych (nigdy wartości zastępcze)."""


class Calibrator(ABC):
    """Kalibracja pewności modelu: dopasowanie na jednej połowie danych, ocena na drugiej."""

    @abstractmethod
    def fit(self, logits: Sequence[Sequence[float]], answers: Sequence[int]) -> None: ...

    @abstractmethod
    def probs(self, logits: Sequence[float]) -> list[float]:
        """Skalibrowany rozkład na opcjach jednego pytania."""

    @abstractmethod
    def params(self) -> dict[str, Any]:
        """Parametry do zapisania w migawce (np. temperatura i liczność zbioru dopasowania)."""


class SelfModel(ABC):
    """Model siebie: przyjmuje pomiary i decyzje, formułuje twierdzenia, sprawdza poprzednie twierdzenia."""

    @abstractmethod
    def observe(self, measurements: Sequence[Measurement]) -> None: ...

    @abstractmethod
    def record(self, decisions: Sequence[Decision]) -> None: ...

    @abstractmethod
    def claims(self) -> list[Claim]: ...

    @abstractmethod
    def check(self, previous: Snapshot | None) -> list[Check]:
        """Twierdzenia z ``previous`` kontra bieżące pomiary (pusta lista, gdy brak poprzedniej migawki)."""

    @abstractmethod
    def snapshot(self) -> Snapshot: ...


class RelationsSource(ABC):
    """Punkt rozszerzenia: pamięć relacji z użytkownikami (ton, historia) prowadzona przez moduł czatu.

    SelfModel nie przechowuje treści relacji; implementacja zwraca tylko stan źródła do migawki, a szczegóły
    konkretnej osoby czyta (z kontrolą dostępu) ten, komu wolno – np. właściciel relacji przez RLS."""

    @abstractmethod
    def status(self) -> dict[str, Any]:
        """``{"source": nazwa, "available": bool, ...}`` – bez danych osobowych."""


class SelfModelStore(ABC):
    """Trwałość migawek. Odczyt publiczny; zapis wyłącznie z uprawnieniami właściciela (implementacja to egzekwuje)."""

    @abstractmethod
    def latest(self) -> Snapshot | None: ...

    @abstractmethod
    def save(self, snap: Snapshot) -> bool:
        """Zapisuje migawkę; False, gdy migawka o tym odcisku już istnieje."""
