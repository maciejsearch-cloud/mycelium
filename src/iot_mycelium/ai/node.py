"""Węzeł grzybni poza przeglądarką (Raspberry Pi, serwer, GitHub Actions).

Mówi z tym samym darmowym backendem co frontend (Supabase REST, klucz publiczny,
RLS + limiter po stronie bazy). Gdy sieć/baza nie odpowiada – działa lokalnie
(plik JSON w cache) i wysyła zaległe wpisy przy następnym połączeniu.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from iot_mycelium.ai.consensus import Answer

SUPABASE_URL = os.environ.get("MYC_SUPABASE_URL", "https://agortpieeygmcttjwjfx.supabase.co")
# Klucz publikowalny (publiczny z założenia, jak w aplikacji webowej); dostęp pilnuje RLS.
SUPABASE_KEY = os.environ.get("MYC_SUPABASE_KEY", "sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P")
KINDS = ("browser", "python", "esp")


def state_dir() -> Path:
    p = Path(os.environ.get("IOT_MYCELIUM_NODE_DIR", Path.home() / ".cache" / "iot-mycelium" / "node"))
    p.mkdir(parents=True, exist_ok=True)
    return p


class Store:
    """Wspólny stan: odpowiedzi, statystyki węzłów, dziennik wzrostu."""

    def __init__(
        self, url: str | None = None, key: str | None = None, offline: bool | None = None, timeout: float = 8.0
    ):
        self.url = (url or SUPABASE_URL).rstrip("/") + "/rest/v1"
        self.key = key or SUPABASE_KEY
        self.timeout = timeout
        self.offline = bool(offline if offline is not None else os.environ.get("MYC_OFFLINE"))
        self.local_path = state_dir() / "local.json"
        self.local: dict[str, Any] = json.loads(self.local_path.read_text()) if self.local_path.exists() else {}
        self.local.setdefault("node_id", str(uuid.uuid4()))
        for k in ("answers", "growth", "outbox"):
            self.local.setdefault(k, [])
        self.online = False

    @property
    def node_id(self) -> str:
        return os.environ.get("MYC_NODE_ID") or self.local["node_id"]

    def save(self) -> None:
        self.local["answers"] = self.local["answers"][-5000:]
        self.local["growth"] = self.local["growth"][-2000:]
        self.local["outbox"] = self.local["outbox"][-500:]
        self.local_path.write_text(json.dumps(self.local))

    def _req(self, method: str, path: str, body: Any = None, prefer: str | None = None) -> Any:
        if self.offline:
            raise ConnectionError("offline")
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if self.key.startswith("sb_"):
            headers.pop("Authorization")
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)  # noqa: S310 – https
        with urllib.request.urlopen(req, timeout=self.timeout) as r:  # noqa: S310
            raw = r.read()
        self.online = True
        return json.loads(raw) if raw else None

    def _post(self, table: str, row: dict[str, Any]) -> bool:
        try:
            path = f"/{table}?on_conflict=question_id,node_id" if table == "myc_answers" else f"/{table}"
            self._req("POST", path, row, prefer="resolution=ignore-duplicates,return=minimal")
            return True
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:  # limiter / awaria – spróbuj później
                self.local["outbox"].append({"table": table, "row": row})
            return False  # 4xx (walidacja) – nie ponawiamy w nieskończoność
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            self.local["outbox"].append({"table": table, "row": row})
            return False

    def flush(self) -> int:
        out, self.local["outbox"] = self.local["outbox"], []
        sent = sum(self._post(o["table"], o["row"]) for o in out)
        return sent

    # ---- odczyt
    def answers(self) -> list[Answer]:
        try:
            rows = self._req(
                "GET", "/myc_answers?select=question_id,node_id,answer,kind,owner,created_at&order=id&limit=20000"
            )
            self.local["answers"] = rows
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            rows = self.local["answers"] + [o["row"] for o in self.local["outbox"] if o["table"] == "myc_answers"]
        return [Answer(r["question_id"], r["node_id"], r["answer"], bool(r.get("owner"))) for r in rows]

    def gold_stats(self) -> dict[str, tuple[int, int]]:
        try:
            rows = self._req("POST", "/rpc/myc_gold_stats", {})
            return {r["node_id"]: (r["n"], r["correct"]) for r in rows}
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            return {}

    def gold_daily(self) -> list[dict[str, Any]]:
        try:
            return self._req("POST", "/rpc/myc_gold_daily", {})
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            return []

    def growth(self, limit: int = 200) -> list[dict[str, Any]]:
        try:
            rows = self._req(
                "GET", f"/myc_growth?select=node_id,kind,event,detail,iq,created_at&order=id.desc&limit={limit}"
            )
            self.local["growth"] = rows
            return rows
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            return list(self.local["growth"])

    # ---- zapis
    def answer(self, qid: str, answer: str, kind: str = "python") -> bool:
        return self._post("myc_answers", {"question_id": qid, "node_id": self.node_id, "answer": answer, "kind": kind})

    def stats(self, acc: dict[str, float], n_answers: int, label: str | None = None, kind: str = "python") -> bool:
        return self._post(
            "myc_node_stats",
            {"node_id": self.node_id, "kind": kind, "label": label, "acc": acc, "n_answers": n_answers},
        )

    def log(self, event: str, detail: dict[str, Any], iq: float | None = None, kind: str = "python") -> bool:
        row = {
            "node_id": self.node_id,
            "kind": kind,
            "agent": os.environ.get("MYC_AGENT", "Pi/cron " + self.node_id[:4]),
            "event": event,
            "detail": detail,
            "iq": iq,
        }
        self.local["growth"].insert(0, {**row, "created_at": None})
        return self._post("myc_growth", row)
