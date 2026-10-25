"""Miary rozbioru na złotym zbiorze UD: UPOS, cechy (UFeats wybranych cech), lemat, UAS/LAS, części zdania, role-F1."""

from __future__ import annotations

from typing import Any

from . import analiza


def _feq(a: dict[str, str], b: dict[str, str]) -> bool:
    return all(a.get(k) == b.get(k) for k in analiza.FEATS)


def score(gold: list[list[dict[str, Any]]], pred: list[list[dict[str, Any]]]) -> dict[str, Any]:
    """gold/pred: listy zdań (tokeny: form, lemma, upos, feats, head, deprel). Tokenizacja wspólna (złota)."""
    c = dict.fromkeys(
        [
            "n",
            "upos",
            "feats",
            "lemma",
            "uas",
            "las",
            "part_n",
            "part",
            "attr_n",
            "attr",
            "clause_g",
            "clause_p",
            "clause_ok",
        ],
        0,
    )
    per = {k: [0, 0] for k in analiza.FEATS}
    tp = fp = fn = 0
    by_q: dict[str, list[int]] = {}
    tense_n = tense_ok = 0
    for g, p in zip(gold, pred, strict=True):
        if len(g) != len(p):
            raise ValueError("różna liczba tokenów")
        ag, ap = analiza.analyse(g), analiza.analyse(p)
        for x, y, tg, tp_ in zip(g, p, ag["tokens"], ap["tokens"]):
            c["n"] += 1
            c["upos"] += x["upos"] == y["upos"]
            c["feats"] += _feq(x.get("feats") or {}, y.get("feats") or {})
            c["lemma"] += (x.get("lemma") or "").lower() == (y.get("lemma") or "").lower()
            c["uas"] += x["head"] == y["head"]
            c["las"] += x["head"] == y["head"] and x["deprel"] == y["deprel"]
            for k in analiza.FEATS:
                gv = (x.get("feats") or {}).get(k)
                if gv is not None:
                    per[k][0] += 1
                    per[k][1] += gv == (y.get("feats") or {}).get(k)
            if tg["part"] != "interpunkcja":
                c["part_n"] += 1
                c["part"] += tg["part"] == tp_["part"]
            if tg["part"] == "przydawka":
                c["attr_n"] += 1
                c["attr"] += tp_["part"] == "przydawka" and tp_["of"] == tg["of"]
        G, P = analiza.triples(ag), analiza.triples(ap)
        tp += len(G & P)
        fp += len(P - G)
        fn += len(G - P)
        for t in G:
            by_q.setdefault(t[1], [0, 0, 0])[0] += 1
        for t in P:
            by_q.setdefault(t[1], [0, 0, 0])[1] += 1
        for t in G & P:
            by_q[t[1]][2] += 1
        cg = {(k["head"], k["type"]) for k in ag["clauses"]}
        cp = {(k["head"], k["type"]) for k in ap["clauses"]}
        c["clause_g"] += len(cg)
        c["clause_p"] += len(cp)
        c["clause_ok"] += len(cg & cp)
        pf = {f["pred"]: f for f in ap["frames"]}
        for f in ag["frames"]:
            tense_n += 1
            q = pf.get(f["pred"])
            tense_ok += bool(q) and all(q[k] == f[k] for k in ("aspect", "tense", "mood", "neg"))
    n = max(c["n"], 1)
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    cf = 2 * c["clause_ok"] / (c["clause_g"] + c["clause_p"]) if c["clause_g"] + c["clause_p"] else 0.0

    def r4(x: float) -> float:
        return round(x, 4)

    return {
        "n_sent": len(gold),
        "n_tok": c["n"],
        "role_f1": r4(f1),
        "role_p": r4(prec),
        "role_r": r4(rec),
        "role_n": tp + fn,
        "upos": r4(c["upos"] / n),
        "feats": r4(c["feats"] / n),
        "lemma": r4(c["lemma"] / n),
        "uas": r4(c["uas"] / n),
        "las": r4(c["las"] / n),
        "part": r4(c["part"] / max(c["part_n"], 1)),
        "attr_head": r4(c["attr"] / max(c["attr_n"], 1)),
        "clause_f1": r4(cf),
        "frame_tam": r4(tense_ok / max(tense_n, 1)),
        "per_feat": {k: r4(v[1] / v[0]) if v[0] else None for k, v in per.items()},
        "per_q": {
            k: {
                "n": v[0],
                "f1": r4(2 * v[2] / (v[0] + v[1])) if v[0] + v[1] else 0.0,
            }
            for k, v in sorted(by_q.items(), key=lambda kv: -kv[1][0])
            if v[0] >= 20
        },
    }
