"""Historia pomiarów: jeden punkt (z datą) po każdym prawdziwym przebiegu ai-bench.

Wykresy we frontendzie budowane są wyłącznie z tych punktów – bez symulacji.
Przebiegi na danych syntetycznych (``synthetic=True``) nie trafiają do historii.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def point(res: dict[str, Any]) -> dict[str, Any]:
    return {
        "t": res["generated_at"],
        "git": res.get("git"),
        "mbs": res["mbs"],
        "mbs_linear": res.get("mbs_linear"),
        "scores": {a["task"]: round(a["test"]["score"], 4) for a in res.get("agents", [])},
    }


def append(res: dict[str, Any], path: Path) -> bool:
    """Dopisuje punkt; zwraca False dla danych syntetycznych lub duplikatu (ten sam czas)."""
    if res.get("synthetic"):
        return False
    p = point(res)
    rows = load(path)
    if any(r["t"] == p["t"] for r in rows):
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(p, ensure_ascii=False) + "\n")
    return True


def load(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return sorted(rows, key=lambda r: r["t"])
