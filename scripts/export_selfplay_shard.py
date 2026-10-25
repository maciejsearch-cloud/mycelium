"""Odłamek treningowy z poprawnie rozwiązanych zadań logicznych (samodzielne ćwiczenia, #63) – „sft” w meta.json.

Wejście: results/selfplay/*-correct.jsonl (odpowiedzi opublikowanej wersji LM uznane przez selfplay.check za poprawne).
Bez nauczyciela i bez człowieka: cel treningu = własna, sprawdzona programem odpowiedź modelu (strata tylko na niej).
Żeby model nie uczył się „zawsze tak”: w kategoriach tak/nie/nie wiadomo każda odpowiedź ma tyle samo przykładów
(kategoria z jedną odpowiedzią odpada), w pozostałych jedna odpowiedź najwyżej MAX_SAME razy. Dedup po sha pytania,
ponowna kontrola przecieku względem zbioru bramki (hash + 8-gramy słów z eval.bin). Zbiór bramki nie jest zmieniany.

Użycie: python scripts/export_selfplay_shard.py --tokenizer <tokenizer.json> [--name sft-logic-0001.bin.gz]
"""

from __future__ import annotations

import argparse
import collections
import gzip
import json
import random
import sys
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
from export_lm_data import chat  # noqa: E402

from iot_mycelium.mesh import lm, selfplay  # noqa: E402

DATA = ROOT / "web" / "public" / "data" / "lm"
CLOSED = {"tak", "nie", "nie wiadomo"}
MAX_SAME = 3


def select(rows: list[dict], seed: int = 0) -> tuple[list[dict], dict]:
    r = random.Random(seed)
    seen, uniq = set(), []
    for x in rows:
        if x["sha"] not in seen:
            seen.add(x["sha"])
            uniq.append(x)
    by = collections.defaultdict(lambda: collections.defaultdict(list))
    for x in uniq:
        by[x["kind"]][x["answer"]].append(x)
    out, report = [], {}
    for kind, groups in sorted(by.items()):
        closed = set(groups) <= CLOSED
        if closed:
            k = min(len(g) for g in groups.values()) if len(groups) >= 2 else 0
            caps = dict.fromkeys(groups, k)
        else:
            caps = {a: min(MAX_SAME, len(g)) for a, g in groups.items()}
        took = []
        for a, g in sorted(groups.items()):
            took += r.sample(g, caps[a])
        out += took
        report[kind] = {
            "correct": sum(len(g) for g in groups.values()),
            "kept": len(took),
            "answers": {a: caps[a] for a in sorted(groups)},
            **(
                {"dropped": "jedna odpowiedź tak/nie/nie wiadomo (podejrzenie zgadywania)"}
                if closed and not took
                else {}
            ),
        }
    return out, report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument(
        "--inputs", nargs="*", default=sorted(str(p) for p in (ROOT / "results" / "selfplay").glob("*-correct.jsonl"))
    )
    ap.add_argument("--name", default="sft-logic-0001.bin.gz")
    ap.add_argument("--t", type=int, default=128)
    a = ap.parse_args()
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(a.tokenizer)
    rows = [json.loads(line) for p in a.inputs for line in Path(p).read_text().splitlines() if line.strip()]
    # przeciek: hash i 8-gramy słów stałego zbioru bramki
    _, eids, emask, _ = lm.unpack_data((DATA / "eval.bin").read_bytes())
    gate = [tok.decode(rw[m].tolist()) for rw, m in zip(eids, emask, strict=True)]
    gate_hash = {selfplay.qhash(t) for t in gate}
    gate_ng = set().union(*(selfplay.ngrams(t, 8) for t in gate))
    clean = [x for x in rows if selfplay.qhash(x["q"]) not in gate_hash and not (selfplay.ngrams(x["q"], 8) & gate_ng)]
    picked, report = select(clean)
    ids, mask = [], []
    for x in picked:
        c = chat(tok, x["q"], "", x["a"], True, a.t)
        if c:
            ids.append(c[0])
            mask.append(c[1])
    meta = json.loads((DATA / "meta.json").read_text())
    info = {
        "kind": "sft-logic",
        "source": "samodzielne ćwiczenia (selfplay v2): odpowiedzi opublikowanej wersji LM sprawdzone programem",
        "inputs": [Path(p).name for p in a.inputs],
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
        "rows_in": len(rows),
        "leak_dropped": len(rows) - len(clean),
        "per_category": report,
        **info,
    }
    meta["sft"] = [f for f in meta.get("sft", []) if f["name"] != a.name] + [entry]
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps({k: v for k, v in entry.items() if k != "per_category"}, ensure_ascii=False))
    for k, v in report.items():
        print(f"  {k}: {v['kept']}/{v['correct']} {v['answers']}{' – ' + v['dropped'] if 'dropped' in v else ''}")


if __name__ == "__main__":
    main()
