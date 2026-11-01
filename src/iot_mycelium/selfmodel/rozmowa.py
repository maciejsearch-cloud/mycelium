"""Źródło „relacje” i decyzje moderacji rozmówcy czatu dla SelfModelu (supabase/myc_rozmowa.sql, docs/rozmowa.md).

Rozmówca prowadzi pamięć relacji w ``myc_self_relations`` (zapis tylko przez RPC, odczyt: osoba o sobie i właściciel)
i zapisuje swoje decyzje moderacyjne (automatyczne wyciszenie zalewu, propozycje dla Developera, ostrzeżenia)
w ``myc_rozmowa_decisions``. Tu są dwie publiczne, bezosobowe funkcje do migawki SelfModelu:

* :func:`relations_status` – czy źródło działa, ile relacji, rozkład tonu (bez pseudonimów i treści);
* :func:`moderation_decisions` – historia decyzji jako :class:`~iot_mycelium.selfmodel.base.Decision`.

Integracja w ``scripts/selfmodel_run.py`` (dwie linie)::

    sm = MeasuredSelfModel(..., relations=rozmowa.relations_status(rpc))
    sm.record(decisions_from_plans(plans) + rozmowa.moderation_decisions(rpc))
"""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Callable
from typing import Any

from .base import Decision

Rpc = Callable[[str, dict[str, Any]], Any]


def supabase_rpc(url: str, key: str, timeout: float = 30) -> Rpc:
    """Wywołanie publicznego RPC PostgREST kluczem publicznym (anon)."""

    def call(fn: str, args: dict[str, Any]) -> Any:
        req = urllib.request.Request(  # noqa: S310 – stały adres https projektu
            f"{url}/rest/v1/rpc/{fn}",
            data=json.dumps(args).encode(),
            headers={"apikey": key, "Content-Type": "application/json", "User-Agent": "myc-selfmodel"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as f:  # noqa: S310
            return json.loads(f.read() or b"null")

    return call


def relations_status(rpc: Rpc) -> dict[str, Any]:
    """Stan źródła relacji; przy błędzie sieci uczciwie ``available: False``."""
    try:
        r = rpc("myc_self_relations_status", {})
    except (OSError, ValueError):
        return {"source": "myc_self_relations", "available": False, "rows": 0}
    return r if isinstance(r, dict) else {"source": "myc_self_relations", "available": False, "rows": 0}


def moderation_decisions(rpc: Rpc, limit: int = 50) -> list[Decision]:
    """Decyzje moderacji rozmówcy (najnowsze najpierw) z ich skutkiem (zastosowana / przyjęta / odrzucona / cofnięta)."""
    try:
        rows = rpc("myc_self_rel_decisions", {"p_limit": limit}) or []
    except (OSError, ValueError):
        return []
    out: list[Decision] = []
    for d in rows:
        choice = {k: int(v) for k, v in (d.get("choice") or {}).items() if isinstance(v, (int, float))}
        out.append(
            Decision(
                id=str(d["id"]),
                at=str(d["at"]),
                kind=str(d["kind"]),
                choice=choice,
                reason=str(d.get("reason") or ""),
                outcome=d.get("outcome"),
                outcome_pl=d.get("outcome_pl"),
            )
        )
    return out
