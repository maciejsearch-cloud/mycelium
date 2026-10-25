"""Punkt odniesienia dla rozbioru: parser spaCy pl_core_news_sm (GPL-3.0, poza zależnościami projektu) + te same
reguły (analiza.py), na złotej tokenizacji testu UD. Wynik → results/rozbior/baseline-spacy.json.

    pip install spacy && python -m spacy download pl_core_news_sm
    python scripts/rozbior_baseline.py
"""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from iot_mycelium.rozbior import miary, zbior  # noqa: E402


def main() -> int:
    import spacy
    from spacy.tokens import Doc

    nlp = spacy.load("pl_core_news_sm", exclude=["tokenizer", "ner"])
    out: dict = {"model": f"spaCy pl_core_news_sm {nlp.meta.get('version')}", "license": nlp.meta.get("license")}
    allg, allp = [], []
    for tb in ("pdb", "lfg"):
        ss = zbior.local(f"test-{tb}")
        gold = [s["toks"] for s in ss]
        t0 = time.time()
        words = ([t["form"] for t in s["toks"]] for s in ss)
        pred = [
            [
                {
                    "form": w.text,
                    "lemma": w.lemma_,
                    "upos": w.pos_,
                    "feats": dict(w.morph.to_dict()),
                    "head": 0 if w.head.i == w.i else w.head.i + 1,
                    "deprel": "root" if w.dep_ == "ROOT" else w.dep_,
                }
                for w in d
            ]
            for d in nlp.pipe((Doc(nlp.vocab, words=ws) for ws in words), batch_size=64)
        ]
        m = miary.score(gold, pred)
        m["sec"] = round(time.time() - t0, 1)
        out[tb] = m
        allg += gold
        allp += pred
        print(tb, {k: v for k, v in m.items() if k not in ("per_q", "per_feat")})
    out["all"] = miary.score(allg, allp)
    print("all", {k: v for k, v in out["all"].items() if k not in ("per_q", "per_feat")})
    p = ROOT / "results" / "rozbior" / "baseline-spacy.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
