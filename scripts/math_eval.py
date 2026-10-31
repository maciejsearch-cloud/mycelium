"""Trafność LM grzybni na typie „matematyczne” (Ucz AI) – stały zestaw E1 do porównań przed/po.

E1 = jawna runda 1 Ucz AI: ``zadania.generate(24, ziarno 1)`` → 120 zadań (5 rodzajów × 24, poziomy 1–3), te same
co w ``results/zadania/sft-math-check-2026-10-25.json``; odłamek ``sft-math-0001`` ich nie zawiera (wyłączone po hashu).
Wybór 1 z 4 przez rozkład log-prob na odpowiedziach (jak ``scripts/zadania_run.py``), bf16 na CPU.

Użycie: PYTHONPATH=src python scripts/math_eval.py --version 4 | --path lm/v5-xxxxxxxx.bin [--out plik.json]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
from selfplay_run import TOK, TOK_REV, option_probs  # noqa: E402
from zadania_run import gate, summary  # noqa: E402

from iot_mycelium.mesh import lm, zadania  # noqa: E402
from iot_mycelium.mesh.net import SB_KEY, SB_URL  # noqa: E402
from iot_mycelium.mesh.qwen import Qwen, ensure_weights  # noqa: E402


def adapter(version: int | None, path: str | None) -> tuple[str, lm.Lora]:
    if path is None:
        h = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}
        u = f"{SB_URL}/rest/v1/myc_models?model=eq.lm&version=eq.{int(version)}&select=path"
        path = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=60).read())[0]["path"]  # noqa: S310
    b = urllib.request.urlopen(f"{SB_URL}/storage/v1/object/public/myc-models/{path}", timeout=120).read()  # noqa: S310
    assert path.endswith(f"-{lm.sha256(b)[:8]}.bin"), "suma SHA-256 nie zgadza się z nazwą"
    return path, lm.Lora.from_bytes(b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", type=int)
    ap.add_argument("--path")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--out")
    a = ap.parse_args()
    from transformers import AutoTokenizer

    t0 = time.time()
    gh, gng, gsha, _ = gate()
    items = [it for it in zadania.generate(24, 1, None, exclude=gh, gate_ngrams=gng) if it.type == "matematyczne"]
    path, lora = adapter(a.version, a.path)
    torch.set_num_threads(a.threads)
    tok = AutoTokenizer.from_pretrained(TOK, revision=TOK_REV)
    m = Qwen(ensure_weights(print), torch.bfloat16)
    m.lora = lm.runtime(lora, m.dtype)
    rows = []
    for i, it in enumerate(items):
        p = option_probs(
            m,
            tok,
            f"z{i}",
            it.q + "\nOdpowiedzi: " + "; ".join(it.options) + ".\nPodaj jedną odpowiedź.",
            list(it.options),
        )
        rows.append((it.kind, it.level, int(np.argmax(p)) == it.answer, it.answer))
    rep = {"set": "E1 (runda 1, ziarno 1, 24/rodzaj)", "adapter": path, "gate_eval_sha": gsha, "dtype": "bf16 cpu",
           "s": round(time.time() - t0, 1), **summary(rows)}  # fmt: skip
    print(json.dumps({k: rep[k] for k in ("adapter", "n", "correct", "acc")}, ensure_ascii=False))
    if a.out:
        Path(a.out).write_text(json.dumps(rep, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    main()
