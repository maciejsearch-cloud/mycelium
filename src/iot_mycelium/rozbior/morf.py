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


SENT_END = {".", "!", "?", "…", ":", "-", "–", "—", '"', "„", "”", "«", "»", "(", "*"}


REL_MIN = 0.01  # P(etykieta | UPOS, przypadki Morfeusza) poniżej progu → łuk i etykieta dekodowane ponownie
FUNC_UPOS = {"CCONJ", "SCONJ", "PART", "ADP", "ADV", "INTJ"}


def proper_only(an: list[tuple[str, str]], form: str, prev: str | None, upos: str) -> list[tuple[str, str]]:
    """Model uznał słowo za nieodmienne słowo funkcyjne (np. „Ani” → spójnik „ani”), a ma ono wielką literę w środku
    zdania i SGJP zna imię/nazwę własną („Ania”) → tylko interpretacje z lematem własnym. Na początku zdania (lub po
    kropce, cudzysłowie itp.) wielka litera nic nie mówi; rzeczowniki pospolite pisane wielką literą („Unii”, „Pan”)
    zostają bez zmian (model ich nie myli ze słowem funkcyjnym)."""
    if upos not in FUNC_UPOS or prev is None or prev in SENT_END or not form[:1].isupper() or form.isupper():
        return an
    pr = [a for a in an if a[0][:1].isupper()]
    return pr or an


NKJP_CASE = {"nom": "Nom", "gen": "Gen", "dat": "Dat", "acc": "Acc", "inst": "Ins", "loc": "Loc", "voc": "Voc"}
NKJP_NUM = {"sg": "Sing", "pl": "Plur"}
NOMINAL = {"subst", "depr", "adj", "ppron12", "ppron3"}
UD_NOMINAL = {"NOUN", "PROPN", "ADJ", "PRON", "DET"}


def agrees(tag: str, u: str, f: dict[str, str]) -> bool:
    """Analiza UD zgodna z tagiem NKJP: jeśli tag ma przypadek/liczbę, analiza musi mieć ten sam przypadek/liczbę.
    (Mapa tag→UD z TRAIN zawiera szum z wyrównania – np. „subst:sg:dat:f” → „NOUN|” bez cech albo mianownik.)"""
    parts = tag.split(":")
    if parts[0] not in NOMINAL or u not in UD_NOMINAL:  # „prep:gen” → ADP bez przypadku; „em” (subst) → AUX w UD
        return True
    cs = {NKJP_CASE[x] for x in parts if x in NKJP_CASE}
    if cs and f.get("Case") not in cs:
        return False
    ns = {NKJP_NUM[x] for x in parts if x in NKJP_NUM}
    if "Plur" in ns:
        ns.add("Ptan")  # plurale tantum („drzwi”, „usta”) – w UD Number=Ptan
    return not (ns and f.get("Number") not in ns)


def ud_key(t: dict[str, Any]) -> str:
    f = t.get("feats") or {}
    return t["upos"] + "|" + "|".join(f"{k}={f[k]}" for k in analiza.FEATS if k in f)


def parse_key(k: str) -> tuple[str, dict[str, str]]:
    up, *fs = k.split("|")
    return up, dict(x.split("=", 1) for x in fs if x)


def case_ctx(toks: list[dict[str, Any]], t: dict[str, Any]) -> str:
    """Kontekst składniowy przypadku: relacja (bez podtypu) + część mowy nadrzędnika, np. „iobj|VERB”."""
    h = int(t["head"])
    return t["deprel"].split(":", 1)[0] + "|" + (toks[h - 1]["upos"] if h else "ROOT")


VAL_CASE = {"KTO/CO": "Nom", "KOGO/CO": "Acc", "KOMU/CZEMU": "Dat", "KIM/CZYM": "Ins", "KOGO/CZEGO": "Gen"}


def licensed(val: dict[str, Any] | None, lemma: str, negated: bool) -> set[str]:
    """Przypadki frazy nominalnej bez przyimka, których wymaga czasownik wg Walentego (IPI PAN, CC BY-SA 4.0);
    przy zaprzeczeniu biernik → dopełniacz („nie dał książki”)."""
    v = (val or {}).get(lemma)
    if not v:
        return set()
    out = {VAL_CASE[x] for f in v["s"] for x in f if x in VAL_CASE}
    if negated and "Acc" in out:
        out.add("Gen")
    return out


def _verb_ctx(tree, sel, h):
    """(lemat, zaprzeczony) czasownika h (od 1) albo None."""
    if not h or sel[h - 1]["upos"] not in ("VERB", "AUX"):
        return None
    neg = any(int(t["head"]) == h and t["deprel"] == "advmod:neg" for t in tree)
    return sel[h - 1].get("lemma") or "", neg


def case_bias(H, fe, tree, M, tb="pdb", beta=0.0, sel=None, gamma=0.0):
    """log P(przypadek | kontekst) z TRAIN (wygładzenie +1) z wagą beta + premia gamma dla przypadków wymaganych
    przez czasownik nadrzędny wg Walentego (tylko fraza bez przyimka)."""
    cp = (M.get("caseprior") or {}).get(tb) or (M.get("caseprior") or {}).get("pdb")
    val = (M.get("walenty") or {}).get("verbs")
    if (not beta or not cp) and (not gamma or not val):
        return fe
    cases = H["feats"]["Case"]
    fc = fe["Case"].copy()
    for i, t in enumerate(tree):
        c = cp.get(case_ctx(tree, t)) if cp and beta else None
        if c:
            tot = sum(c.values()) + len(cases)
            fc[i] += beta * np.log(np.array([(c.get(v, 0) + 1) / tot for v in cases], np.float32))
        if gamma and val and sel is not None and t["deprel"] != "nsubj":
            vc = _verb_ctx(tree, sel, int(t["head"]))
            if vc and not any(int(x["head"]) == i + 1 and x["deprel"] == "case" for x in tree):
                lic = licensed(val, vc[0], vc[1]) - {"Nom"}
                fc[i] += np.array([gamma if v in lic else 0.0 for v in cases], np.float32)
    return {**fe, "Case": fc}


def build_map(train: list[dict[str, Any]], cache: dict[str, list] | None = None) -> dict[str, Any]:
    """Mapa tag NKJP → rozkład analiz UD (osobno dla stylu treebanku) + słownik forma→lemat z train."""
    tagmap: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    relp: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    casep: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    flem: dict[str, Counter] = defaultdict(Counter)
    cache = {} if cache is None else cache
    for s in train:
        tb = s.get("tb", "pdb")
        for t in s["toks"]:
            if t["upos"] == "PUNCT":
                continue
            relp[tb][t["upos"]][t["deprel"]] += 1
            if "Case" in (t.get("feats") or {}):
                relp[tb][t["upos"] + "|" + t["feats"]["Case"]][t["deprel"]] += 1
            casep[tb][case_ctx(s["toks"], t)][(t.get("feats") or {}).get("Case", "_")] += 1
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
        "relprior": {tb: {u: dict(c) for u, c in m.items()} for tb, m in relp.items()},
        "caseprior": {tb: {k: dict(c) for k, c in m.items()} for tb, m in casep.items()},
    }


def model_probs(
    H: dict[str, Any], W: dict[str, np.ndarray], forms: list[str], tb: str, unk: frozenset[int] = frozenset()
) -> tuple[np.ndarray, dict]:
    """Rozkłady UPOS i cech (log-softmax) dla każdego słowa – te same wagi co model.predict."""
    x = model.hidden(H, W, forms, tb, unk)[1:]

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
    case_beta: float | None = None,
    val_gamma: float | None = None,
) -> list[dict[str, Any]]:
    """Poprawia lemat, UPOS i cechy przewidzianych tokenów (kopie). lex=None → pełny Morfeusz, inaczej leksykon.
    Gdy Morfeusz zmienił część mowy, łuk i etykieta tych słów są dekodowane ponownie (redecode)."""
    forms = [t["form"] for t in toks]
    up, fe = model_probs(H, W, forms, tb)
    sel = select(H, toks, up, fe, M, tb, alpha, min_p, cache, keep_upos, lex)
    meta = M.get("meta") or {}
    beta = float(meta.get("case_beta", 0.0)) if case_beta is None else case_beta
    gamma = float(meta.get("val_gamma", 0.0)) if val_gamma is None else val_gamma
    tree, unk = redecode(H, W, toks, sel, M, tb, cache, lex, gamma)
    if unk:  # zdanie przeliczone z „Ani” jako słowem nieznanym → nowe rozkłady cech; UPOS z pierwszego wyboru
        up, fe = model_probs(H, W, forms, tb, unk)
        toks = [{**t, "upos": s["upos"]} if s["upos"] != t["upos"] else t for t, s in zip(toks, sel)]
    if beta or gamma or unk:
        fb = case_bias(H, fe, tree, M, tb, beta, sel, gamma)
        sel = select(H, toks, up, fb, M, tb, alpha, min_p, cache, keep_upos, lex)
    return [{**s, "head": r["head"], "deprel": r["deprel"], "p": r["p"]} for s, r in zip(sel, tree)]


def _cases(an: list[tuple[str, str]], upos: str) -> list[str]:
    """Przypadki dopuszczone przez Morfeusza dla wybranej części mowy (rzeczownik/przymiotnik/zaimek)."""
    cls = {"NOUN": ("subst", "depr"), "PROPN": ("subst", "depr"), "ADJ": ("adj",), "PRON": ("ppron12", "ppron3")}
    out = []
    for _lm, tag in an:
        parts = tag.split(":")
        if parts[0] in cls.get(upos, ()):
            out += [NKJP_CASE[x] for x in parts if x in NKJP_CASE]
    return sorted(set(out))


def redecode(H, W, toks, sel, M, tb="pdb", cache=None, lex=None, gamma=0.0):
    """Słowa, którym Morfeusz zmienił część mowy (np. „Ani”: spójnik „ani” → imię „Ania”), dostają łuk i etykietę
    zgodne z nową analizą: log P(etykieta | UPOS, przypadki z Morfeusza) z TRAIN UD dołożone do dekodowania drzewa
    (model.predict z force). Słowo funkcyjne zamienione na imię/rzeczownik jest dodatkowo czytane jako nieznane
    (wektor „ani” to spójnik) – zdanie liczone jest ponownie. Zwraca (drzewo, unk); cechy/lematy zostają z select."""
    rp = (M.get("relprior") or {}).get(tb) or (M.get("relprior") or {}).get("pdb")
    val = (M.get("walenty") or {}).get("verbs")
    force = {}
    for i, (t, s) in enumerate(zip(toks, sel)):
        u = s["upos"]
        if u == "PUNCT":
            continue
        if lex is not None:
            an = lex_analyses(lex, t["form"])
        else:
            an = cache.get(t["form"]) if cache is not None and t["form"] in cache else analyses(t["form"])
        keys = [f"{u}|{c}" for c in _cases(an, u) if f"{u}|{c}" in rp]
        if u == t["upos"] and not keys:
            continue
        cnt: Counter = Counter()
        for k in keys or [u]:
            cnt.update(rp.get(k, {}))
        tot = sum(cnt.values())
        # ta sama część mowy: ponownie tylko gdy etykieta przeczy przypadkom z Morfeusza („Ani” [dop./cel./msc.] jako nsubj)
        if u == t["upos"] and tot and cnt.get(t["deprel"], 0) / tot >= REL_MIN:
            continue
        force[i] = model.rel_logprior(H, cnt)
        cs = set(_cases(an, u)) - {"Nom"}
        if val and gamma and cs:  # premia łuku: czasownik, którego schemat (Walenty) wymaga jednego z tych przypadków
            hb = np.zeros(len(toks) + 1, np.float32)
            for h in range(1, len(toks) + 1):
                if h != i + 1 and sel[h - 1]["upos"] == "VERB":
                    neg = any(x["form"].lower() == "nie" and x["upos"] == "PART" for x in toks[max(0, h - 3) : h - 1])
                    if cs & licensed(val, sel[h - 1].get("lemma") or "", neg):
                        hb[h] = gamma
            force[i] = (force[i], hb)
    if not force:
        return toks, frozenset()
    ch = list(force)
    unk = frozenset(i for i in ch if toks[i]["upos"] in FUNC_UPOS and sel[i]["upos"] not in FUNC_UPOS)
    return model.predict(H, W, [t["form"] for t in toks], tb, force=force, unk=unk), unk


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
        an = proper_only(an, t["form"], toks[i - 1]["form"] if i else None, t["upos"])
        if t["upos"] == "PUNCT" or (an and all(tag == "interp" for _lm, tag in an)):
            out.append(t)
            continue
        cand: dict[str, list] = {}  # klucz UD → [wynik, zbiór lematów]
        # analizy niezgodne z tagiem (szum wyrównania) odpadają przed progiem min_p, a ich masa przechodzi na zgodne
        # analizy imienne – inaczej „subst:sg:dat:f” → PROPN|Dat ginie pod masą miejscownika. Część mowy musi jednak
        # przejść próg min_p w surowym rozkładzie któregoś tagu słowa (jak dotąd) – przeskalowanie zmienia tylko, które
        # cechy (przypadek, liczba) tej części mowy zostają kandydatami
        dists = []
        for lm, tag in an:
            dist = tmap.get(tag) if tag != "interp" else None
            if dist:
                tot = sum(dist.values())
                nom = {k for k in dist if parse_key(k)[0] in UD_NOMINAL}
                ok = {k for k in nom if agrees(tag, *parse_key(k))}
                sc = sum(dist[k] for k in nom) / sum(dist[k] for k in ok) if ok else 1.0
                dists.append((lm, tag, dist, tot, nom, ok, sc))
        ups = {
            parse_key(k)[0]
            for _l, _t, d, tot, nom, ok, _s in dists
            for k, c in d.items()
            if c / tot >= min_p and (k not in nom or k in ok)
        }
        for lm, _tag, dist, tot, nom, ok, scale in dists:
            for k, c in dist.items():
                if k in nom and k not in ok:
                    continue
                p = c * (scale if k in ok else 1.0) / tot
                if p < min_p or parse_key(k)[0] not in ups:
                    continue
                u, f = parse_key(k)
                if k in cand:
                    cand[k][0] = max(cand[k][0], cand[k][2] + alpha * math.log(p))
                    cand[k][1].add(lm)
                    continue
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
