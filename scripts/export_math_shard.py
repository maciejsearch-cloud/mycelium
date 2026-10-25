"""Odłamek „sft” z zadań matematycznych generowanych programem (arytmetyka, ułamki, procenty, równania, zadania tekstowe).

Bez nauczyciela i bez człowieka: zadanie i poprawna odpowiedź liczone są programem (``mesh/zadania.py``), cel treningu =
tekst poprawnej odpowiedzi po pytaniu w tym samym formacie, w jakim ``scripts/zadania_run.py`` mierzy model
(pytanie + „Odpowiedzi: …; …. Podaj jedną odpowiedź.”, nagłówek czatu Qwen jak w apply_chat_template).
Strata tylko na odpowiedzi.

Poza odłamkiem (sprawdzane po hashu samego pytania, więc te same liczby w innym ułożeniu odpowiedzi też odpadają):
* jawna runda 1 Ucz AI (ziarno 1, ``--eval-per-kind`` na rodzaj) – na niej mierzymy model przed/po,
* bieżąca pula pytań kontrolnych (``web/public/data/zadania/queue.json``),
* zbiór bramki LM (``eval.bin``: hash + 8-gramy słów) – bramka publikacji nie jest zmieniana.

Ziarna generatora: od ``--seed`` (domyślnie 1000) w górę, rozłączne z rundą 1 (ziarno 1).

Użycie: python scripts/export_math_shard.py --tokenizer <tokenizer.json> [--per-kind 200] [--name sft-math-0001.bin.gz]
"""

from __future__ import annotations

import argparse
import collections
import gzip
import json
import sys
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
from export_lm_data import PAD  # noqa: E402

from iot_mycelium.mesh import lm, selfplay, zadania  # noqa: E402

DATA = ROOT / "web" / "public" / "data" / "lm"
QUEUE = ROOT / "web" / "public" / "data" / "zadania" / "queue.json"


def prompt(it: zadania.Item) -> str:
    """Ten sam tekst pytania co w pomiarze (scripts/zadania_run.py: lm_eval)."""
    return it.q + "\nOdpowiedzi: " + "; ".join(it.options) + ".\nPodaj jedną odpowiedź."


# domyślny prompt systemowy szablonu czatu Qwen2.5 – ten sam nagłówek, z którym pomiar (apply_chat_template) liczy odpowiedzi
QWEN_SYS = "You are Qwen, created by Alibaba Cloud. You are a helpful assistant."


def encode(tok, q: str, ans: str, T: int):
    """(ids, mask) długości T, strata tylko na odpowiedzi i <|im_end|>; None, gdy się nie mieści."""
    head = f"<|im_start|>system\n{QWEN_SYS}<|im_end|>\n<|im_start|>user\n{q}<|im_end|>\n<|im_start|>assistant\n"
    a, b = tok.encode(head).ids, tok.encode(ans + "<|im_end|>").ids
    if len(a) + len(b) > T:
        return None
    n = len(a) + len(b)
    return a + b + [PAD] * (T - n), [0] * len(a) + [1] * len(b) + [0] * (T - n)


def held_out(eval_per_kind: int) -> set[str]:
    """Hashe pytań, które nie mogą trafić do treningu: jawna runda 1 i bieżąca pula pytań kontrolnych."""
    out = {selfplay.qhash(it.q) for it in zadania.generate(eval_per_kind, 1)}
    if QUEUE.exists():
        out |= {selfplay.qhash(x["q"]) for x in json.loads(QUEUE.read_text())["items"]}
    return out


def build(per_kind: int, seed: int, exclude: set[str], gate_hash: set[str], gate_ng: set) -> list[zadania.Item]:
    """per_kind zadań na rodzaj (poziomy 1–3 po równo), bez powtórzeń pytania i bez przecieku z bramki."""
    out, seen = [], set(exclude) | set(gate_hash)
    by = collections.Counter()
    s = seed
    while min((by[k] for k in zadania.MATH), default=0) < per_kind and s < seed + 10_000:
        for it in zadania.generate(max(1, per_kind // 10), s, gate_ngrams=gate_ng):
            h = selfplay.qhash(it.q)
            if by[it.kind] >= per_kind or h in seen or selfplay.qhash(prompt(it)) in gate_hash:
                continue
            seen.add(h)
            by[it.kind] += 1
            out.append(it)
        s += 1
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--per-kind", type=int, default=200)
    ap.add_argument("--eval-per-kind", type=int, default=24)
    ap.add_argument("--seed", type=int, default=1000)
    ap.add_argument("--name", default="sft-math-0001.bin.gz")
    ap.add_argument("--t", type=int, default=128)
    a = ap.parse_args()
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(a.tokenizer)
    _, eids, emask, _ = lm.unpack_data((DATA / "eval.bin").read_bytes())
    gate = [tok.decode(rw[m].tolist()) for rw, m in zip(eids, emask, strict=True)]
    gate_hash = {selfplay.qhash(t) for t in gate}
    gate_ng = set().union(*(selfplay.ngrams(t, 8) for t in gate))
    held = held_out(a.eval_per_kind)
    items = build(a.per_kind, a.seed, held, gate_hash, gate_ng)
    ids, mask, too_long = [], [], 0
    for it in items:
        c = encode(tok, prompt(it), it.options[it.answer], a.t)
        if c:
            ids.append(c[0])
            mask.append(c[1])
        else:
            too_long += 1
    meta = json.loads((DATA / "meta.json").read_text())
    info = {
        "kind": "sft-math",
        "source": "zadania matematyczne generowane programem (mesh/zadania.py), odpowiedź liczona programem",
        "seeds": [a.seed, "…"],
        "held_out": {"round1_seed": 1, "round1_per_kind": a.eval_per_kind, "queue": QUEUE.name, "n_hashes": len(held)},
        "gate_eval_sha": meta["eval"]["sha256"],
        "license": "dane generowane programem (repozytorium projektu)",
    }
    b = gzip.compress(lm.pack_data(info, torch.tensor(ids), torch.tensor(mask)), 6, mtime=0)
    (DATA / a.name).write_bytes(b)
    entry = {
        "name": a.name,
        "sha256": lm.sha256(b),
        "bytes": len(b),
        "n": len(ids),
        "answer_tokens": int(torch.tensor(mask).sum()),
        "too_long": too_long,
        "per_kind": dict(collections.Counter(it.kind for it in items)),
        "per_level": {str(k): v for k, v in sorted(collections.Counter(it.level for it in items).items())},
        **info,
    }
    meta["sft"] = [f for f in meta.get("sft", []) if f["name"] != a.name] + [entry]
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps(entry, ensure_ascii=False))


if __name__ == "__main__":
    main()
