"""Zbiór rozbioru zdań z Universal Dependencies (polski): UD_Polish-PDB i UD_Polish-LFG.

    python scripts/export_rozbior.py --ud /ścieżka/do/conllu --out web/public/data/rozbior

Oficjalne podziały train/dev/test zostają bez zmian; każdy treebank w osobnych plikach (różne licencje).
Pliki: {split}-{tb}-NN.json.gz (gzip bez znacznika czasu → stałe SHA-256), meta.json (źródła, licencje, rewizje,
liczby zdań/tokenów/ról, SHA-256 plików, odcisk zbioru testowego = bramka role-F1). Test nigdy nie trafia do treningu.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iot_mycelium.rozbior import analiza, conllu  # noqa: E402

SOURCES = {
    "pdb": {
        "name": "UD_Polish-PDB (Polish Dependency Bank 2.0 w UD)",
        "url": "https://github.com/UniversalDependencies/UD_Polish-PDB",
        "license": "CC BY-NC-SA 4.0",
        "authors": "Alina Wróblewska i in. (IPI PAN)",
    },
    "lfg": {
        "name": "UD_Polish-LFG (POLFIE / LFG treebank w UD)",
        "url": "https://github.com/UniversalDependencies/UD_Polish-LFG",
        "license": "GPL-3.0",
        "authors": "Agnieszka Patejuk, Adam Przepiórkowski (IPI PAN)",
    },
}
PER = 2000


def gz(obj) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0, compresslevel=9) as f:
        f.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode())
    return buf.getvalue()


def sent_json(s: conllu.Sent, tb: str) -> dict:
    return {
        "id": s.sid,
        "tb": tb,
        "text": s.text,
        "toks": [
            {
                "form": t.form,
                "lemma": t.lemma,
                "upos": t.upos,
                "feats": {k: v for k, v in t.feats.items() if k in analiza.FEAT_PL},
                "head": t.head,
                "deprel": t.deprel,
                **({} if t.space else {"sa": 0}),
            }
            for t in s.toks
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ud", required=True)
    ap.add_argument("--out", default="web/public/data/rozbior")
    ap.add_argument("--rev", default="", help="rewizje repozytoriów UD, np. pdb=abc123,lfg=def456")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    revs = dict(x.split("=") for x in a.rev.split(",") if "=" in x)
    meta = {"sources": {}, "files": {}, "splits": {}, "roles": {}}
    for tb, src in SOURCES.items():
        meta["sources"][tb] = {**src, "rev": revs.get(tb)}
        for split in ("train", "dev", "test"):
            ss = [sent_json(s, tb) for s in conllu.read(str(Path(a.ud) / f"pl_{tb}-ud-{split}.conllu"))]
            n_roles = sum(len(analiza.triples(analiza.analyse(s["toks"]))) for s in ss)
            meta["splits"][f"{split}-{tb}"] = {
                "sents": len(ss),
                "toks": sum(len(s["toks"]) for s in ss),
                "roles": n_roles,
            }
            chunks = [ss] if split == "test" else [ss[i : i + PER] for i in range(0, len(ss), PER)]
            for k, ch in enumerate(chunks):
                name = f"{split}-{tb}.json.gz" if split == "test" else f"{split}-{tb}-{k:02d}.json.gz"
                b = gz({"tb": tb, "license": src["license"], "source": src["url"], "sents": ch})
                (out / name).write_bytes(b)
                meta["files"][name] = hashlib.sha256(b).hexdigest()
    tests = sorted(n for n in meta["files"] if n.startswith("test-"))
    meta["eval_files"] = tests
    meta["eval_sha"] = hashlib.sha256("|".join(meta["files"][n] for n in tests).encode()).hexdigest()
    meta["eval_n"] = sum(meta["splits"][n[:-8]]["sents"] for n in tests)
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps(meta["splits"], ensure_ascii=False), meta["eval_n"], meta["eval_sha"])


if __name__ == "__main__":
    main()
