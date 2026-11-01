"""Wyniki opcji każdego pytania stałego testu LM (to samo co :func:`iot_mycelium.mesh.lm.evaluate_iter`).

``evaluate_iter`` zwraca tylko liczbę trafień; SelfModel potrzebuje rozkładu na opcjach (do kalibracji), więc
tu liczymy ten sam wynik opcji (średni log-prob tokenów odpowiedzi) i oddajemy go w całości. Wymaga torch.
"""

from __future__ import annotations

import json
from collections.abc import Callable

import torch

from iot_mycelium.mesh import lm


@torch.no_grad()
def mc_scores(
    m, lora: lm.Lora | None, eval_bytes: bytes, batch: int = 16, progress: Callable[[int, int], None] | None = None
) -> tuple[list[list[float]], list[int]]:
    """[[wynik opcji 0..3] na pytanie], [poprawna] – kolejność pytań jak w eval.bin."""
    _, ids, mask, extra = lm.unpack_data(eval_bytes)
    mc = json.loads(extra.decode())
    rows = sorted((r for opts, _ in mc for r in opts), key=lambda r: int(mask[r].nonzero().max()))
    score: dict[int, float] = {}
    for i in range(0, len(rows), batch):
        r = rows[i : i + batch]
        sub_ids, sub_mask = lm._trim(ids[r], mask[r])
        h = lm.hidden(m, lora, sub_ids)
        for j, row in enumerate(r):
            sel = sub_mask[j, 1:]
            score[row] = -float(lm._ce(h[j, :-1][sel], sub_ids[j, 1:][sel], m.emb).mean())
        if progress:
            progress(min(i + batch, len(rows)), len(rows))
    return [[round(score[o], 5) for o in opts] for opts, _ in mc], [int(a) for _, a in mc]
