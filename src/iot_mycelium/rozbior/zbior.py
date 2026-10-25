"""Zbiór rozbioru (pliki z export_rozbior.py): odczyt, sprawdzenie SHA-256, odcisk zbioru oceny (bramka role-F1)."""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "web" / "public" / "data" / "rozbior"
PARITY = DATA / "parity.json"


def gate_sha(meta: dict[str, Any], parity: bytes) -> str:
    """Odcisk bramki = pliki testu + odcisk reguł (zmiana reguł analizy = nowy zbiór oceny, nie cicha zmiana miary)."""
    return hashlib.sha256(f"{meta['eval_sha']}|{hashlib.sha256(parity).hexdigest()}".encode()).hexdigest()


def read_files(files: dict[str, bytes], prefix: str) -> list[dict[str, Any]]:
    out = []
    for name in sorted(files):
        if name.startswith(prefix):
            out += json.loads(gzip.decompress(files[name]))["sents"]
    return out


def local(prefix: str, d: Path = DATA) -> list[dict[str, Any]]:
    meta = json.loads((d / "meta.json").read_text())
    files = {}
    for name, sha in meta["files"].items():
        if name.startswith(prefix):
            b = (d / name).read_bytes()
            if hashlib.sha256(b).hexdigest() != sha:
                raise ValueError(f"suma SHA-256 nie zgadza się: {name}")
            files[name] = b
    return read_files(files, prefix)


def evaluate(H, W, sents: list[dict[str, Any]], limit: int | None = None) -> dict[str, Any]:
    """Pełna ocena modelu na złotej tokenizacji (numpy) – ta sama funkcja u węzła, weryfikatora i w raporcie."""
    from . import miary, model

    ss = sents[:limit] if limit else sents
    gold = [s["toks"] for s in ss]
    pred = [model.predict(H, W, [t["form"] for t in s["toks"]], "pdb") for s in ss]
    m = miary.score(gold, pred)
    by_tb: dict[str, list[int]] = {}
    for k, s in enumerate(ss):
        by_tb.setdefault(s.get("tb", "pdb"), []).append(k)
    m["by_tb"] = {
        tb: {
            k: v
            for k, v in miary.score([gold[i] for i in ix], [pred[i] for i in ix]).items()
            if k not in ("per_q", "per_feat")
        }
        for tb, ix in by_tb.items()
    }
    return m
