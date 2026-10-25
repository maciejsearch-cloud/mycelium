"""Warstwa Morfeusz 2 / SGJP: lematy i cechy fleksyjne z analizatora + wybór interpretacji przez model grzybni.

Morfeusz 2 (IPI PAN; dane fleksyjne SGJP: Z. Saloni, W. Gruszczyński, M. Woliński, R. Wołosz, D. Skowrońska;
Polimorf: IPI PAN) – licencja BSD 2-klauzulowa, http://morfeusz.sgjp.pl/doc/license/ .

Jak działa (bez zgadywania reguł ręcznie):
1. ``build_map`` – na podziale TRAIN UD liczy, jakim analizom UD (UPOS + cechy) odpowiadają tagi NKJP Morfeusza
   (osobno dla stylu PDB i LFG – treebanki różnie znakują np. żywotność). Test UD nigdy nie jest tu czytany.
2. ``choose`` – dla każdego słowa kandydaci = interpretacje Morfeusza (lemat, tag) → analizy UD z mapy; wynik =
   log P_model(UPOS) + Σ log P_model(cecha) + α·log P(analiza | tag). Lemat = lemat Morfeusza wybranej interpretacji
   (remis: częstość pary forma–lemat w train). Słowa nieznane Morfeuszowi zostają z przewidywaniem modelu.
Drzewo (head/deprel) się nie zmienia – role-F1 może się zmienić tylko przez cechy (np. przypadek → pytanie).
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Any

import numpy as np

from . import analiza, model

_M = None


def morfeusz():
    global _M
    if _M is None:
        import morfeusz2  # BSD-2, pip install morfeusz2

        _M = morfeusz2.Morfeusz(expand_tags=True)
    return _M


def lemma_of(lm: str) -> str:
    """„zamek:s1” → „zamek” (Morfeusz rozróżnia homonimy przyrostkiem)."""
    return lm.split(":", 1)[0] if ":" in lm and not lm.startswith(":") else lm


def analyses(form: str) -> list[tuple[str, str]]:
    """[(lemat, tag NKJP)] – tylko interpretacje obejmujące całe słowo jednym segmentem."""
    out = []
    for i, j, (_orth, lm, tag, _q, _k) in morfeusz().analyse(form):
        if i == 0 and j == 1:
            out.append((lemma_of(lm), tag))
    # wiele segmentów (np. aglutynant) → brak pełnej interpretacji jednym segmentem
    return list(dict.fromkeys(out))


def ud_key(t: dict[str, Any]) -> str:
    f = t.get("feats") or {}
    return t["upos"] + "|" + "|".join(f"{k}={f[k]}" for k in analiza.FEATS if k in f)


def parse_key(k: str) -> tuple[str, dict[str, str]]:
    up, *fs = k.split("|")
    return up, dict(x.split("=", 1) for x in fs if x)


def build_map(train: list[dict[str, Any]], cache: dict[str, list] | None = None) -> dict[str, Any]:
    """Mapa tag NKJP → rozkład analiz UD (osobno dla stylu treebanku) + słownik forma→lemat z train."""
    tagmap: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    flem: dict[str, Counter] = defaultdict(Counter)
    cache = {} if cache is None else cache
    for s in train:
        tb = s.get("tb", "pdb")
        for t in s["toks"]:
            if t["upos"] == "PUNCT":
                continue
            fl = t["form"].lower()
            flem[fl][t.get("lemma") or fl] += 1
            an = cache.get(t["form"])
            if an is None:
                an = cache[t["form"]] = analyses(t["form"])
            gl = (t.get("lemma") or "").lower()
            tags = [tag for lm, tag in an if lm.lower() == gl] or [tag for _lm, tag in an]
            if not tags:
                continue
            k = ud_key(t)
            for tag in set(tags):
                tagmap[tb][tag][k] += 1.0 / len(set(tags))
    return {
        "tagmap": {tb: {tag: dict(c) for tag, c in m.items()} for tb, m in tagmap.items()},
        "flem": {f: c.most_common(3) for f, c in flem.items()},
    }


def model_probs(H: dict[str, Any], W: dict[str, np.ndarray], forms: list[str], tb: str) -> tuple[np.ndarray, dict]:
    """Rozkłady UPOS i cech (log-softmax) dla każdego słowa – te same wagi co model.predict."""
    x = model.hidden(H, W, forms, tb)[1:]

    def ls(z: np.ndarray) -> np.ndarray:
        z = z - z.max(1, keepdims=True)
        return z - np.log(np.exp(z).sum(1, keepdims=True))

    up = ls(x @ W["upos_w"].T + W["upos_b"])
    fe = {k: ls(x @ W[f"f_{k}_w"].T + W[f"f_{k}_b"]) for k in analiza.FEATS}
    return up, fe


def lex_analyses(lex: dict[str, Any], form: str) -> list[tuple[str, str]]:
    """Analizy z leksykonu przeglądarki (web/public/data/rozbior/morf.json.gz): forma dokładna + małymi literami."""
    out: list[tuple[str, str]] = []
    for f in dict.fromkeys([form, form.lower()]):
        for r, ti in lex["forms"].get(f, []):
            out.append((model.apply_rule(f, lex["rules"][r]), lex["tags"][ti]))
    return list(dict.fromkeys(out))


def choose(
    H: dict[str, Any],
    W: dict[str, np.ndarray],
    toks: list[dict[str, Any]],
    M: dict[str, Any],
    tb: str = "pdb",
    alpha: float = 0.5,
    min_p: float = 0.02,
    cache: dict[str, list] | None = None,
    keep_upos: bool = True,
    lex: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Poprawia lemat, UPOS i cechy przewidzianych tokenów (kopie). lex=None → pełny Morfeusz, inaczej leksykon."""
    up, fe = model_probs(H, W, [t["form"] for t in toks], tb)
    return select(H, toks, up, fe, M, tb, alpha, min_p, cache, keep_upos, lex)


def select(H, toks, up, fe, M, tb="pdb", alpha=0.5, min_p=0.02, cache=None, keep_upos=True, lex=None):
    """Rdzeń wyboru (lustro TS: web/src/myc/morf.ts) – up/fe = log-prawdopodobieństwa modelu."""
    uix = {u: i for i, u in enumerate(H["upos"])}
    fix = {k: {v: i for i, v in enumerate(H["feats"][k])} for k in analiza.FEATS}
    tmap = M["tagmap"].get(tb) or M["tagmap"].get("pdb", {})
    out = []
    for i, t in enumerate(toks):
        t = dict(t)
        if lex is not None:
            an = lex_analyses(lex, t["form"])
        else:
            an = None if cache is None else cache.get(t["form"])
            if an is None:
                an = analyses(t["form"])
                if cache is not None:
                    cache[t["form"]] = an
        if t["upos"] == "PUNCT" or (an and all(tag == "interp" for _lm, tag in an)):
            out.append(t)
            continue
        cand: dict[str, list] = {}  # klucz UD → [wynik, zbiór lematów]
        for lm, tag in an:
            dist = tmap.get(tag) if tag != "interp" else None
            if not dist:
                continue
            tot = sum(dist.values())
            for k, c in dist.items():
                p = c / tot
                if p < min_p:
                    continue
                if k in cand:
                    cand[k][0] = max(cand[k][0], cand[k][2] + alpha * math.log(p))
                    cand[k][1].add(lm)
                    continue
                u, f = parse_key(k)
                if u not in uix:
                    continue
                base = up[i, uix[u]]
                for fk in analiza.FEATS:
                    j = fix[fk].get(f.get(fk, "_"))
                    if j is None:
                        base = -math.inf
                        break
                    base += fe[fk][i, j]
                if base == -math.inf:
                    continue
                cand[k] = [base + alpha * math.log(p), {lm}, base]
        fl = dict(M["flem"].get(t["form"].lower()) or [])
        # UPOS modelu (97% na teście) zostaje, jeśli Morfeusz ma interpretację z tą częścią mowy
        same = [q for q in cand if q.split("|", 1)[0] == t["upos"]]
        if keep_upos and same:
            cand = {q: cand[q] for q in same}
        if cand:
            k = max(cand, key=lambda q: cand[q][0])
            u, f = parse_key(k)
            lems = cand[k][1]
            t["upos"], t["feats"] = u, f
            # remis lematów: najczęstszy w train dla tej formy, potem kolejność Morfeusza
            t["lemma"] = max(lems, key=lambda x: (fl.get(x, 0), -[a for a, _ in an].index(x)))
            t["morf"] = 1
        elif fl and t["upos"] != "PUNCT":
            t["lemma"] = max(fl, key=fl.get)
        out.append(t)
    return out
