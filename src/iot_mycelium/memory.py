"""Mycelium Memory – wspólna pamięć agentów (thread-safe i process-safe).

Przechowuje najlepsze wagi (najniższy loss), umożliwiając transfer wiedzy między agentami.

Poprawki względem poprzedniej wersji:

* ``update_memory`` trzyma blokadę przez cały cykl *odczyt → porównanie → zapis*.
  Wcześniej blokada była zwalniana między odczytem a zapisem, więc dwa procesy
  mogły nadpisać sobie nawzajem lepszy wynik (utracone aktualizacje).
* Zapis jest atomowy (plik tymczasowy + ``os.replace``) – czytelnik nigdy nie
  zobaczy połowy pliku JSON, nawet gdy proces zostanie zabity w trakcie zapisu.
* Domyślna ścieżka nie zależy już od katalogu roboczego (``paths.mycelium_path``).

Od wersji 0.3 (format v2) pamięć ma **osobny slot dla każdego kształtu sieci**
(``shape_signature``). Wcześniej był jeden globalny slot i trening sieci o innej
architekturze kasował całą grzybnię. Stare pliki (v1) są migrowane automatycznie.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from filelock import FileLock

from iot_mycelium.paths import mycelium_path

LOCK_TIMEOUT_S = 30
FORMAT_VERSION = 2

Shapes = dict[str, tuple[int, ...]]


def shape_signature(shapes: Shapes) -> str:
    """Klucz slotu, np. ``W1=2x16;W2=16x1;b1=1x16;b2=1x1`` (kolejność kluczy bez znaczenia)."""
    return ";".join(f"{k}={'x'.join(map(str, shape))}" for k, shape in sorted(shapes.items()))


def _now() -> str:
    return datetime.now().isoformat()


def _empty_slot() -> dict[str, Any]:
    return {
        "best_loss": float("inf"),
        "best_weights": None,
        "metadata": {"created_at": _now(), "last_updated": None, "total_updates": 0, "best_agent_id": None},
    }


def _empty_memory() -> dict[str, Any]:
    return {
        "version": FORMAT_VERSION,
        "slots": {},
        "metadata": {
            "created_at": _now(),
            "last_updated": None,
            "total_updates": 0,
            "best_agent_id": None,
        },
    }


def _migrate(data: dict[str, Any]) -> dict[str, Any]:
    """Format v1 (jeden globalny slot) → v2 (slot na kształt sieci)."""
    if data.get("version") == FORMAT_VERSION:
        return data
    migrated = _empty_memory()
    old_meta = dict(data.get("metadata") or {})
    migrated["metadata"].update(old_meta)
    if data.get("best_weights"):
        shapes = {k: np.asarray(v).shape for k, v in data["best_weights"].items()}
        slot = _empty_slot()
        slot["best_loss"] = data.get("best_loss", float("inf"))
        slot["best_weights"] = data["best_weights"]
        slot["metadata"].update(old_meta)
        slot["metadata"]["total_updates"] = 1
        migrated["slots"][shape_signature(shapes)] = slot
    return migrated


class MyceliumMemory:
    """Wspólna pamięć agentów (Mycelium Network)."""

    def __init__(self, memory_path: str | os.PathLike[str] | None = None):
        self.memory_path = Path(memory_path).resolve() if memory_path else mycelium_path()
        self.lock_path = Path(str(self.memory_path) + ".lock")
        self.memory_path.parent.mkdir(parents=True, exist_ok=True)
        # Jeden obiekt blokady na instancję: FileLock jest reentrant, więc metody
        # mogą się zagnieżdżać bez zakleszczenia.
        self._lock = FileLock(self.lock_path, timeout=LOCK_TIMEOUT_S)
        with self._lock:
            if not self.memory_path.exists():
                self._write_unlocked(_empty_memory())

    # ------------------------------------------------------------------ I/O
    def _write_unlocked(self, data: dict[str, Any]) -> None:
        fd, tmp = tempfile.mkstemp(dir=self.memory_path.parent, prefix=".mycelium-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.memory_path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def _read_unlocked(self) -> dict[str, Any]:
        if not self.memory_path.exists():
            data = _empty_memory()
            self._write_unlocked(data)
            return data
        try:
            with open(self.memory_path) as f:
                data = json.load(f)
            if data.get("version") != FORMAT_VERSION:
                data = _migrate(data)
                self._write_unlocked(data)
            return data
        except (json.JSONDecodeError, AttributeError, TypeError):
            # Uszkodzony plik (np. z poprzedniej, nieatomowej wersji) – zaczynamy od nowa.
            data = _empty_memory()
            self._write_unlocked(data)
            return data

    def _read_memory(self) -> dict[str, Any]:
        with self._lock:
            return self._read_unlocked()

    def _write_memory(self, data: dict[str, Any]) -> None:
        with self._lock:
            self._write_unlocked(data)

    # --------------------------------------------------------------- wagi
    def get_fusion_weights(
        self,
        shapes: dict[str, tuple[int, ...]],
        alpha: float = 0.7,
        rng: np.random.Generator | None = None,
    ) -> dict[str, np.ndarray]:
        """Miesza wagi z grzybni z nowymi losowymi wagami.

        ``W = W_grzybni * alpha + W_losowe * (1 - alpha)``; gdy grzybnia jest pusta
        lub kształt się nie zgadza, używane są same losowe wagi (Xavier).
        """
        if not 0.0 <= alpha <= 1.0:
            raise ValueError("alpha musi być w zakresie [0, 1]")
        slot = self._read_memory()["slots"].get(shape_signature(shapes))
        random_weights = self._generate_random_weights(shapes, rng)
        if slot is None or slot["best_weights"] is None:
            return random_weights

        mycelium_weights = {k: np.asarray(v, dtype=float) for k, v in slot["best_weights"].items()}
        fusion: dict[str, np.ndarray] = {}
        for key, shape in shapes.items():
            stored = mycelium_weights.get(key)
            if stored is not None and stored.shape == tuple(shape):
                fusion[key] = stored * alpha + random_weights[key] * (1 - alpha)
            else:
                fusion[key] = random_weights[key]
        return fusion

    @staticmethod
    def _generate_random_weights(
        shapes: dict[str, tuple[int, ...]], rng: np.random.Generator | None = None
    ) -> dict[str, np.ndarray]:
        rng = rng or np.random.default_rng()
        weights: dict[str, np.ndarray] = {}
        for key, shape in shapes.items():
            if key.startswith("W") and len(shape) == 2:
                fan_in, fan_out = shape
                limit = np.sqrt(6 / (fan_in + fan_out))
                weights[key] = rng.uniform(-limit, limit, shape)
            elif key.startswith("W"):
                weights[key] = rng.standard_normal(shape) * 0.1
            else:
                weights[key] = np.zeros(shape)
        return weights

    def update_memory(
        self,
        weights: dict[str, np.ndarray],
        loss: float,
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        """Zapisuje wagi w slocie ich kształtu, jeśli ``loss`` bije rekord tego slotu.

        Sloty innych architektur pozostają nietknięte. Cała operacja odbywa się
        pod jedną blokadą (atomowo względem innych wątków i procesów).
        """
        loss = float(loss)
        if not np.isfinite(loss):
            return False
        signature = shape_signature({k: np.asarray(v).shape for k, v in weights.items()})
        with self._lock:
            memory = self._read_unlocked()
            slot = memory["slots"].get(signature) or _empty_slot()
            if loss >= slot["best_loss"]:
                return False
            now = _now()
            slot["best_loss"] = loss
            slot["best_weights"] = {k: np.asarray(v).tolist() for k, v in weights.items()}
            slot["metadata"]["last_updated"] = now
            slot["metadata"]["total_updates"] += 1
            memory["metadata"]["last_updated"] = now
            memory["metadata"]["total_updates"] += 1
            memory["metadata"]["last_slot"] = signature
            if metadata:
                for target in (slot["metadata"], memory["metadata"]):
                    if "agent_id" in metadata:
                        target["best_agent_id"] = metadata["agent_id"]
                    target.update({k: v for k, v in metadata.items() if k != "total_updates"})
            memory["slots"][signature] = slot
            self._write_unlocked(memory)
            return True

    # -------------------------------------------------------------- odczyt
    def _slot(self, shapes: Shapes | None) -> dict[str, Any] | None:
        if shapes is None:
            return None
        return self._read_memory()["slots"].get(shape_signature(shapes))

    def get_best_loss(self, shapes: Shapes | None = None) -> float:
        """Rekord slotu danego kształtu albo najlepszy loss ze wszystkich slotów."""
        if shapes is not None:
            slot = self._slot(shapes)
            return float(slot["best_loss"]) if slot else float("inf")
        slots = self._read_memory()["slots"].values()
        return min((float(s["best_loss"]) for s in slots), default=float("inf"))

    def get_metadata(self, shapes: Shapes | None = None) -> dict[str, Any]:
        if shapes is not None:
            slot = self._slot(shapes)
            return slot["metadata"] if slot else {}
        return self._read_memory()["metadata"]

    def is_empty(self, shapes: Shapes | None = None) -> bool:
        if shapes is not None:
            return self._slot(shapes) is None
        return not self._read_memory()["slots"]

    def reset(self, shapes: Shapes | None = None) -> None:
        """Czyści jeden slot (``shapes``) albo całą grzybnię."""
        with self._lock:
            if shapes is None:
                self._write_unlocked(_empty_memory())
                return
            memory = self._read_unlocked()
            memory["slots"].pop(shape_signature(shapes), None)
            self._write_unlocked(memory)

    def list_slots(self) -> list[dict[str, Any]]:
        """Podsumowanie slotów, posortowane od najczęściej aktualizowanych."""
        rows = []
        for signature, slot in self._read_memory()["slots"].items():
            meta = slot["metadata"]
            rows.append(
                {
                    "signature": signature,
                    "best_loss": slot["best_loss"],
                    "total_updates": meta.get("total_updates", 0),
                    "task_name": meta.get("task_name"),
                    "accuracy": meta.get("accuracy"),
                    "best_agent_id": meta.get("best_agent_id"),
                    "last_updated": meta.get("last_updated"),
                }
            )
        return sorted(rows, key=lambda r: (-r["total_updates"], r["signature"]))

    def get_stats(self, shapes: Shapes | None = None) -> dict[str, Any]:
        memory = self._read_memory()
        if shapes is not None:
            slot = memory["slots"].get(shape_signature(shapes)) or _empty_slot()
            meta = slot["metadata"]
            return {
                "is_empty": slot["best_weights"] is None,
                "best_loss": slot["best_loss"],
                "total_updates": meta["total_updates"],
                "last_updated": meta["last_updated"],
                "created_at": meta["created_at"],
                "slots": 1 if slot["best_weights"] is not None else 0,
            }
        return {
            "is_empty": not memory["slots"],
            "best_loss": min((float(s["best_loss"]) for s in memory["slots"].values()), default=float("inf")),
            "total_updates": memory["metadata"]["total_updates"],
            "last_updated": memory["metadata"]["last_updated"],
            "created_at": memory["metadata"]["created_at"],
            "slots": len(memory["slots"]),
        }
