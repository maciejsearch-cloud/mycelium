"""Warstwa Morfeusz 2 / SGJP dla rozbioru: mapa tagów NKJP → UD (z TRAIN UD), leksykon przeglądarki, ocena na teście.

Morfeusz 2 + dane fleksyjne SGJP/Polimorf – licencja BSD-2 (http://morfeusz.sgjp.pl/doc/license/), pip: morfeusz2.
Leksykon przeglądarki = formy wygenerowane Morfeuszem dla lematów występujących ≥2 razy w TRAIN UD (+ formy z TRAIN);
formy testu UD nie są dokładane (pokrycie testu w przeglądarce jest uczciwe, nie dopasowane).

    python scripts/export_morf.py --model /ścieżka/rb-v0-q8.bin   # → web/public/data/rozbior/morf.json.gz,
                                                                  #   results/rozbior/morf-eval.json
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from iot_mycelium.rozbior import miary, model, morf, zbior  # noqa: E402

OUT = zbior.DATA / "morf.json.gz"
RES = ROOT / "results" / "rozbior" / "morf-eval.json"
PARITY = zbior.DATA / "morf-parity.json"
N_PARITY = 60


def build_lex(train, M, min_lemma: int = 2) -> dict:
    import morfeusz2

    mg = morfeusz2.Morfeusz(expand_tags=True, generate=True)
    useful = set().union(*M["tagmap"].values())
    lc = Counter(t["lemma"] for s in train for t in s["toks"] if t["upos"] not in ("PUNCT", "NUM", "X", "SYM"))
    forms = {t["form"] for s in train for t in s["toks"] if t["upos"] != "PUNCT"}
    for lm, c in lc.items():
        if c < min_lemma:
            continue
        try:
            for f, *_ in mg.generate(lm):
                forms.add(f)
        except Exception:  # noqa: BLE001,S112 – lemat nieznany generatorowi
            continue
    tags: dict[str, int] = {}
    rules: dict[str, int] = {}
    out: dict[str, list] = {}
    for f in sorted(forms):
        an = [(lm, tag) for lm, tag in morf.analyses(f) if tag in useful]
        if not an:
            continue
        out[f] = [
            [rules.setdefault(model.lemma_rule(f, lm), len(rules)), tags.setdefault(tag, len(tags))] for lm, tag in an
        ]
    return {"tags": list(tags), "rules": list(rules), "forms": out}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--alpha", type=float, default=0.5)
    ap.add_argument(
        "--tb",
        default="pdb",
        choices=["pdb", "lfg"],
        help="licencja = treebank: pdb → morf.json.gz (CC BY-NC-SA 4.0), lfg → morf-lfg.json.gz (GPL-3.0); bez mieszania",
    )
    a = ap.parse_args()
    t0 = time.time()
    train = [s for s in zbior.local("train-") if s.get("tb") == a.tb]
    out_path = OUT if a.tb == "pdb" else OUT.with_name("morf-lfg.json.gz")
    res_path = RES if a.tb == "pdb" else RES.with_name("morf-lfg-eval.json")
    M = morf.build_map(train)
    lex = build_lex(train, M)
    flem = {f: c for f, c in M["flem"].items()}
    blob = {
        "meta": {
            "source": "Morfeusz 2 (morfeusz2 1.99) + dane fleksyjne SGJP/Polimorf, IPI PAN",
            "license": "BSD-2-Clause",
            "license_url": "http://morfeusz.sgjp.pl/doc/license/",
            "authors": "IPI PAN (program, Polimorf); Z. Saloni, W. Gruszczyński, M. Woliński, R. Wołosz, D. Skowrońska (SGJP)",
            "tagmap_from": f"UD Polish {a.tb.upper()} train (test nigdy)",
            "derived_data_license": "CC-BY-NC-SA-4.0" if a.tb == "pdb" else "GPL-3.0",
            "alpha": a.alpha,
            "min_p": 0.02,
            "n_forms": len(lex["forms"]),
        },
        "tagmap": {a.tb: M["tagmap"][a.tb]},
        "flem": flem,
        **lex,
    }
    raw = gzip.compress(json.dumps(blob, ensure_ascii=False, separators=(",", ":")).encode(), 9, mtime=0)
    out_path.write_bytes(raw)
    print(f"leksykon {len(lex['forms'])} form, {len(raw) / 1e6:.2f} MB, {time.time() - t0:.0f} s", flush=True)

    H, W = model.load(Path(a.model).read_bytes())
    test = zbior.local("test-")
    gold = [s["toks"] for s in test]
    base = [model.predict(H, W, [t["form"] for t in s["toks"]], a.tb) for s in test]
    cache: dict = {}
    full = [morf.choose(H, W, b, M, a.tb, a.alpha, cache=cache) for b in base]
    lexd = json.loads(gzip.decompress(raw))
    brow = [morf.choose(H, W, b, lexd, a.tb, a.alpha, lex=lexd) for b in base]
    keys = ("upos", "feats", "lemma", "role_f1", "las", "part", "attr_head", "frame_tam", "per_feat")
    n_tok = sum(1 for s in test for t in s["toks"] if t["upos"] != "PUNCT")
    cov = sum(1 for s in test for t in s["toks"] if t["upos"] != "PUNCT" and morf.lex_analyses(lexd, t["form"]))
    cov_full = sum(1 for s in test for t in s["toks"] if t["upos"] != "PUNCT" and cache.get(t["form"]))
    res = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model": Path(a.model).name,
        "model_sha256": hashlib.sha256(Path(a.model).read_bytes()).hexdigest(),
        "morf_sha256": hashlib.sha256(raw).hexdigest(),
        "split": f"UD test (PDB+LFG), styl {a.tb.upper()} dla wszystkich zdań (jak w czacie)",
        "tb": a.tb,
        "n_sent": len(test),
        "n_tok": sum(len(g) for g in gold),
        "coverage_full": round(cov_full / n_tok, 4),
        "coverage_browser": round(cov / n_tok, 4),
        "v0": {k: v for k, v in miary.score(gold, base).items() if k in keys},
        "v0_morfeusz": {k: v for k, v in miary.score(gold, full).items() if k in keys},
        "v0_morf_browser": {k: v for k, v in miary.score(gold, brow).items() if k in keys},
    }
    # zgodność TS ↔ Python: te same log-prawdopodobieństwa (zaokrąglone) → ten sam wybór w morf.ts i morf.select
    fx = []
    for b in base[: N_PARITY // 2] + base[-N_PARITY // 2 :]:
        up, fe = morf.model_probs(H, W, [t["form"] for t in b], "pdb")
        up = np.round(up.astype(np.float64), 4)
        fe = {k: np.round(v.astype(np.float64), 4) for k, v in fe.items()}
        toks = [
            {
                **{k: t[k] for k in ("form", "lemma", "upos", "feats")},
                "lp": {"upos": up[i].tolist(), "feats": {k: fe[k][i].tolist() for k in fe}},
            }
            for i, t in enumerate(b)
        ]
        sel = morf.select(H, b, up, fe, lexd, "pdb", a.alpha, lex=lexd)
        fx.append({"toks": toks, "want": [{k: t.get(k) for k in ("lemma", "upos", "feats")} for t in sel]})
    if a.tb != "pdb":  # zgodność TS ↔ Python liczona dla domyślnego wariantu
        res_path.write_text(json.dumps(res, ensure_ascii=False, indent=1) + "\n")
        print(json.dumps({k: v for k, v in res.items() if k.startswith(("v0", "cov"))}, ensure_ascii=False))
        return 0
    PARITY.write_text(
        json.dumps(
            {"head": {"upos": H["upos"], "feats": {k: H["feats"][k] for k in fe}}, "sents": fx},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )
    res_path.write_text(json.dumps(res, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps({k: v for k, v in res.items() if k.startswith(("v0", "cov"))}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
