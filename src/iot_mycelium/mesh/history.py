"""Dziennik węzła na dysku: <pamięć podręczna>/history-<nazwa>.jsonl (tylko lokalnie, maks. ok. 2×4 MB).

Wiersz: {"t": unix, "kind": "job"|"log"|"net"|"settings"|"account"|"error", "msg": str, ...}. Nigdy nie zapisujemy
tokenów sesji ani kodów odzyskiwania (scrub() usuwa je też z dowolnego tekstu).
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import threading
import time
from pathlib import Path

from .qwen import cache_dir

MAX_BYTES = 4 * 1024 * 1024
_SECRET = re.compile(
    r"(MYC-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"
    r"|(?:refresh_token|access_token|Bearer)[\"':= ]+[A-Za-z0-9._-]{8,})"
)


def scrub(s: str) -> str:
    return _SECRET.sub("[ukryte]", s)


class History:
    def __init__(self, name: str, path: Path | None = None):
        self.path = path or cache_dir() / f"history-{name}.jsonl"
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def add(self, kind: str, msg: str, **extra) -> None:
        row = {"t": round(time.time(), 3), "kind": kind, "msg": scrub(str(msg))[:2000]}
        for k, v in extra.items():
            row[k] = scrub(v) if isinstance(v, str) else v
        line = json.dumps(row, ensure_ascii=False, default=str) + "\n"
        with self.lock, contextlib.suppress(OSError):
            if self.path.exists() and self.path.stat().st_size > MAX_BYTES:
                os.replace(self.path, self.path.with_suffix(".1.jsonl"))
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line)

    def _rows(self):
        for p in (self.path.with_suffix(".1.jsonl"), self.path):
            with contextlib.suppress(OSError), open(p, encoding="utf-8") as f:
                for line in f:
                    with contextlib.suppress(ValueError):
                        yield json.loads(line)

    def query(self, q: str = "", kind: str = "", limit: int = 300, before: float | None = None) -> list[dict]:
        q = q.lower().strip()
        out = []
        for r in self._rows():
            if kind and r.get("kind") != kind:
                continue
            if before and r.get("t", 0) >= before:
                continue
            if q and q not in json.dumps(r, ensure_ascii=False).lower():
                continue
            out.append(r)
        return out[-max(1, min(limit, 2000)) :][::-1]

    def daily(self, days: int = 14) -> list[dict]:
        """Zadania zakończone przez ten węzeł dzień po dniu (z lokalnego dziennika)."""
        agg: dict[str, dict] = {}
        lo = time.time() - days * 86400
        for r in self._rows():
            if r.get("kind") != "job" or r.get("t", 0) < lo:
                continue
            d = time.strftime("%Y-%m-%d", time.localtime(r["t"]))
            a = agg.setdefault(d, {"day": d, "jobs": 0, "s": 0.0})
            a["jobs"] += 1
            a["s"] += float(r.get("ms") or 0) / 1000
        return [agg[k] for k in sorted(agg)]
