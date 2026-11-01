"""Przydział mocy węzła: wątki CPU, limit czasu pracy (CPU %), RAM, GPU i udział rodzajów zadań.

Zapis: <pamięć podręczna>/alloc-<nazwa>.json (pisze go tylko lokalny panel). Brak pliku = ustawienia z wiersza
poleceń (węzły serwerowe --headless). Harmonogram mierzy prawdziwy czas pracy każdego zadania w oknie 10 min:
zadanie danego rodzaju startuje tylko, gdy łączny czas pracy < CPU % okna i czas tego rodzaju < jego udział.
To ogranicza średnie obciążenie (zadanie, które już trwa, nie jest przerywane).
"""

from __future__ import annotations

import contextlib
import itertools
import json
import os
import time
from collections import deque
from pathlib import Path

from .qwen import cache_dir

WINDOW = 600.0
# rodzaje zadań, które węzeł PC naprawdę wykonuje (czat zawsze: odpowiada ludziom na żywo)
KINDS = {
    "lm_train": "Trening modelu językowego (LoRA, w tym destylacja od Qwen 1.5B)",
    "lm_eval": "Ocena wersji modelu (bramka 2000 pytań)",
    "taxo": "Słowa i strzępki (kategorie, fragmenty)",
    "rozbior": "Rozumienie zdań (rozbiór: części mowy, części zdania, role) – uczenie federacyjne",
    "wallet": "Walidacja transakcji MYC-test (podpisy Ed25519, łańcuch skrótów, korzeń Merkle, dowód pracy)",
}
# rodzaje, których węzeł PC jeszcze nie dostaje (pokazywane uczciwie jako niedostępne)
PLANNED = {
    "images": "Zadania obrazkowe (obrót, rozpoznawanie, OCR) – na razie tylko w przeglądarce",
    "redteam": "Węzły testujące (szukanie zmyśleń) – w przygotowaniu",
}


# tryb pasywny (passive.py): domyślnie wyłączony – tylko za wyraźną zgodą w panelu
PASSIVE_DEFAULT = {"on": False, "seed": True, "witness": True, "disk_gb": 2.0, "daily_gb": 1.0}
# Bitcoin Puzzle #71 (docs/puzzle71.md): domyślnie WYŁĄCZONE – tylko za wyraźną zgodą; pct = % wątków węzła (maks. 10)
P71_DEFAULT = {"on": False, "pct": 10}


def _clamp(v, lo, hi, d):
    try:
        v = type(d)(v)
    except (TypeError, ValueError):
        return d
    return max(lo, min(hi, v))


def defaults(threads: int, ram_gb: float) -> dict:
    return {
        "threads": threads,
        "cpu_pct": 100,
        "ram_gb": ram_gb,
        "gpu_on": False,
        "gpu_pct": 50,
        "shares": dict.fromkeys(KINDS, 100),
        "compute_on": True,  # False = węzeł nie oddaje mocy obliczeniowej (np. tylko tryb pasywny)
        "passive": dict(PASSIVE_DEFAULT),
        "p71": dict(P71_DEFAULT),
    }


def sanitize(a: dict, base: dict) -> dict:
    n = os.cpu_count() or 1
    sh = a.get("shares") if isinstance(a.get("shares"), dict) else {}
    pa = a.get("passive") if isinstance(a.get("passive"), dict) else {}
    pz = a.get("p71") if isinstance(a.get("p71"), dict) else {}
    return {
        "threads": _clamp(a.get("threads", base["threads"]), 1, n, int(base["threads"])),
        "cpu_pct": _clamp(a.get("cpu_pct", base["cpu_pct"]), 5, 100, 100),
        "ram_gb": _clamp(a.get("ram_gb", base["ram_gb"]), 0, 1024, 0.0),
        "gpu_on": bool(a.get("gpu_on", base["gpu_on"])),
        "gpu_pct": _clamp(a.get("gpu_pct", base["gpu_pct"]), 0, 100, 50),
        "shares": {k: _clamp(sh.get(k, base["shares"].get(k, 100)), 0, 100, 100) for k in KINDS},
        "compute_on": bool(a.get("compute_on", base.get("compute_on", True))),
        "passive": {
            "on": bool(pa.get("on", False)),
            "seed": bool(pa.get("seed", True)),
            "witness": bool(pa.get("witness", True)),
            "disk_gb": _clamp(pa.get("disk_gb", 2.0), 0.1, 500, 2.0),
            "daily_gb": _clamp(pa.get("daily_gb", 1.0), 0.05, 100, 1.0),
        },
        "p71": {"on": bool(pz.get("on", False)), "pct": _clamp(pz.get("pct", 10), 1, 10, 10)},
    }


def alloc_path(name: str) -> Path:
    return cache_dir() / f"alloc-{name}.json"


def load(name: str, base: dict) -> tuple[dict, bool]:
    with contextlib.suppress(OSError, ValueError):
        return sanitize(json.loads(alloc_path(name).read_text()), base), True
    return dict(base), False


def save(name: str, a: dict) -> None:
    p = alloc_path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(a, indent=1))
    os.replace(tmp, p)


class Scheduler:
    def __init__(self, alloc: dict, clock=time.monotonic):
        self.alloc = alloc
        self.clock = clock
        self.runs: deque[tuple[float, float, str]] = deque()  # (start, end, rodzaj)
        self.active: dict[int, tuple[float, str]] = {}
        self.totals: dict[str, dict] = {}
        self.waits = 0
        self._ids = itertools.count(1)
        self.paused = False  # np. na czas testu GPU (pomiar CPU bez innych zadań)

    def _busy(self, kind: str | None = None) -> float:
        now = self.clock()
        lo = now - WINDOW
        while self.runs and self.runs[0][1] < lo:
            self.runs.popleft()
        b = sum(min(e, now) - max(s, lo) for s, e, k in self.runs if kind is None or k == kind)
        b += sum(now - max(s, lo) for s, k in self.active.values() if kind is None or k == kind)
        return max(0.0, b)

    def allowed(self, kind: str) -> bool:
        share = self.alloc["shares"].get(kind, 100)
        if share <= 0 or not self.alloc.get("compute_on", True) or self.paused:
            return False
        cpu = self.alloc["cpu_pct"] / 100
        if self._busy() >= cpu * WINDOW:
            return False
        return not (share < 100 and self._busy(kind) >= cpu * share / 100 * WINDOW)

    def start(self, kind: str) -> int:
        tok = next(self._ids)
        self.active[tok] = (self.clock(), kind)
        return tok

    def end(self, tok: int, label: str | None = None) -> float:
        """Koniec zadania; `label` = osobny licznik w statystykach (np. destylacja w ramach lm_train)."""
        s, kind = self.active.pop(tok, (self.clock(), "?"))
        e = self.clock()
        self.runs.append((s, e, kind))
        t = self.totals.setdefault(label or kind, {"n": 0, "s": 0.0})
        t["n"] += 1
        t["s"] += e - s
        return e - s

    @contextlib.contextmanager
    def job(self, kind: str):
        tok = self.start(kind)
        try:
            yield
        finally:
            self.end(tok)

    def view(self) -> dict:
        return {
            "window_s": WINDOW,
            "busy_pct": round(self._busy() / WINDOW * 100, 1),
            "by_kind_pct": {k: round(self._busy(k) / WINDOW * 100, 1) for k in {*KINDS, *self.totals}},
            "totals": self.totals,
            "active": sorted({k for _, k in self.active.values()}),
            "waits": self.waits,
        }
