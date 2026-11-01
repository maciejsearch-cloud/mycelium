"""Trwałość migawek SelfModelu w Supabase (tabela ``myc_self_model``, supabase/myc_self_model.sql).

Odczyt: publiczny REST (klucz publikowalny, RLS: tylko select). Zapis: wyłącznie funkcją ``sql`` z uprawnieniami
właściciela (Management API) – bez niej :meth:`SupabaseSelfStore.save` odmawia. Klucze nigdy nie są wypisywane.
"""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Callable
from typing import Any

from .base import SelfModelStore, Snapshot

SqlFn = Callable[[str], Any]


def lit(x: Any) -> str:
    """Literał SQL: tekst albo JSON w apostrofach, apostrofy podwojone."""
    return "'" + (x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)).replace("'", "''") + "'"


class SupabaseSelfStore(SelfModelStore):
    def __init__(self, url: str, key: str, sql: SqlFn | None = None, timeout: float = 60) -> None:
        self.url, self.key, self.sql, self.timeout = url.rstrip("/"), key, sql, timeout

    def latest(self) -> Snapshot | None:
        r = urllib.request.Request(  # noqa: S310 – stały adres https projektu
            f"{self.url}/rest/v1/myc_self_model?select=snapshot&order=id.desc&limit=1",
            headers={"apikey": self.key, "User-Agent": "myc-selfmodel"},
        )
        with urllib.request.urlopen(r, timeout=self.timeout) as f:  # noqa: S310 – stały adres https projektu
            rows = json.loads(f.read())
        return Snapshot.from_json(rows[0]["snapshot"]) if rows else None

    def save(self, snap: Snapshot) -> bool:
        if self.sql is None:
            raise PermissionError("zapis migawki wymaga uprawnień właściciela (Management API)")
        j = snap.to_json()
        res = self.sql(
            "insert into myc_self_model (fingerprint, snapshot) values ("  # noqa: S608 – wartości przez lit()
            f"{lit(snap.fingerprint)}, {lit(j)}::jsonb) on conflict (fingerprint) do nothing returning id"
        )
        self.sql("select myc_self_model_gc()")
        return bool(res)
