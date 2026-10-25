"""Krok 3: role z rozbioru → logika (rozumowanie na drzewie zależności, bez modelu językowego).

Pytanie jest dzielone na zdania, każde parsowane modelem rozbioru (v0 + leksykon Morfeusza, ten sam co w przeglądarce).
Z drzewa i ról powstają:
- literały: zdanie składowe → (zbiór tematów lematów treści, biegunowość); przeczenie = część „przeczenie”
  przy orzeczeniu, „nieprawda, że …” odwraca biegunowość zdania dopełnieniowego;
- reguły A→B: zdanie okolicznikowe (advcl) z dowolnym spójnikiem podrzędnym → poprzednik, zdanie nadrzędne → następnik
  (struktura, nie lista spójników – stąd „gdy”, „o ile”, „jeżeli” działają, choć szablony mają tylko „jeśli”);
- zdania z kwantyfikatorem (wszystkie/każdy/niektóre/któreś/jakieś/żaden, „nie wszystkie”): (Q, klasa = podmiot, orzeczenie);
  orzecznik rzeczownikowy przy „wszystkie X” → zawieranie klas X ⊂ Y (sylogizm);
- aspekt orzeczenia z cech (Perf/Imp) i „przerwać” → czy czynność skończona;
- „Kto …?” / „Komu …?” → podmiot / dopełnienie w celowniku (lemat = mianownik); kolejność „wcześniej niż”, liczby przy podmiocie.
Wnioskowanie: domknięcie modus ponens + modus tollens, kwadrat logiczny, zawieranie klas.

Uczciwie: reguły pisane ZE ZNAJOMOŚCIĄ szablonów selfplay (słownictwo: „nieprawda”, „przerwać”, „wcześniej”, „najwyższy/
najniższy”, „pierwszy/ostatni”, para „mały/duży” pochodzą z szablonów). Nie dodawano słownictwa spoza szablonów po
napisaniu parafraz – braki leksykalne na parafrazach są zostawione i widoczne w wyniku. Gdy rozbiór nie daje jednoznacznej
struktury, rozumujący NIE zgaduje: zwraca None (wstrzymanie = błąd w trafności).
"""

from __future__ import annotations

import gzip
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import analiza, model, morf

DROP_UPOS = {"PUNCT", "SCONJ", "CCONJ", "ADP", "AUX", "PART"}
DROP_LEM = {
    "nie",
    "czy",
    "to",
    "wiadomo",
    "że",
    "pewno",
    "na",
    "być",
    "ten",
    "tym",
    "razem",
    "zawsze",
    "potem",
    "jeśli",
    "gdy",
    "ponieważ",
}  # spójniki z szablonów, gdy model da im inny UPOS
Q_WORDS = (("nie wszys", "notall"), ("wszys", "all"), ("każd", "all"), ("niektór", "some"), ("któr", "some"),
           ("jakie", "some"), ("jakiś", "some"), ("żadn", "none"), ("żaden", "none"))  # fmt: skip
ANT = {"mały": "duży", "duży": "mały"}  # jedyna para przeciwieństw z szablonów
INSTR = re.compile(r"^(odpowiedz|podaj|wybierz)\b", re.I)


def stem(lemma: str) -> str:
    """Temat do porównań: lemat bez końcowej samogłoski, 5 znaków (Morfeusz bywa niejednoznaczny: róża/róż)."""
    w = (lemma or "").lower()
    while len(w) > 2 and w[-1] in "aeiouyąę":
        w = w[:-1]
    return w[:5]


WRAP = {"wiadomo", "nieprawda", "okazać"}  # „wiadomo, że”, „nieprawda, że”, „okazało się, że” (z szablonów)


class Parser:
    def __init__(self, bin_path: str, lex_path: str):
        self.H, self.W = model.load(Path(bin_path).read_bytes())
        self.lex = json.loads(gzip.decompress(Path(lex_path).read_bytes()))
        wal = Path(lex_path).with_name("walenty.json.gz")  # schematy czasowników (Walenty) – przypadek dopełnień
        if wal.exists():
            self.lex["walenty"] = json.loads(gzip.decompress(wal.read_bytes()))
        self.cache: dict[str, dict] = {}

    def __call__(self, s: str) -> dict[str, Any]:
        if s not in self.cache:
            forms = re.findall(r"\d+|\w+|[^\w\s]", s)
            toks = model.predict(self.H, self.W, forms)
            toks = morf.choose(self.H, self.W, toks, self.lex, lex=self.lex)
            self.cache[s] = analiza.analyse(toks)
        return self.cache[s]


def sentences(text: str) -> list[str]:
    out, buf, q = [], "", False
    for ch in text:
        buf += ch
        if ch in "„":
            q = True
        elif ch in "”":
            q = False
        elif ch in ".?!" and not q:
            if buf.strip():
                out.append(buf.strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())
    return [s for s in out if not INSTR.match(s)]


# ------------------------------------------------------------------ drzewo
@dataclass
class Tree:
    toks: list[dict[str, Any]]

    def __post_init__(self):
        self.kids: dict[int, list[int]] = {}
        for t in self.toks:
            self.kids.setdefault(t["head"], []).append(t["i"])

    def t(self, i: int) -> dict[str, Any]:
        return self.toks[i - 1]

    def root(self) -> int:
        return next(t["i"] for t in self.toks if t["head"] == 0)

    def sub(self, i: int, stop: set[int] = frozenset()) -> list[int]:
        out, st = [], [i]
        while st:
            x = st.pop()
            out.append(x)
            st += [c for c in self.kids.get(x, []) if c not in stop]
        return sorted(out)

    def clause_heads(self, i: int) -> list[int]:
        """Dzieci-zdania (advcl, ccomp, conj-orzeczenia) węzła i."""
        return [c for c in self.kids.get(i, []) if analiza.base(self.t(c)["deprel"]) in ("advcl", "ccomp", "csubj")]


@dataclass(frozen=True)
class Lit:
    key: frozenset
    pol: bool

    def neg(self) -> Lit:
        return Lit(self.key, not self.pol)


def _lit(T: Tree, head: int, stop: set[int], ids: list[int] | None = None) -> Lit | None:
    ids = ids if ids is not None else T.sub(head, stop)
    neg = False
    key = set()
    for i in ids:
        t = T.t(i)
        lem = (t["lemma"] or t["form"]).lower()
        if t["part"] == "przeczenie" or lem == "nie":
            neg = not neg
            continue
        if len(t["form"]) == 1 and t["form"].isupper():  # „lampka A” – litera jako nazwa
            key.add(t["form"])
            continue
        if t["upos"] in DROP_UPOS or lem in DROP_LEM or lem in WRAP or lem == "się":
            continue
        key.add(stem(lem))
    return Lit(frozenset(key), not neg) if key else None


def literal(T: Tree, head: int, stop: set[int] | None = None) -> Lit | None:
    """Zdanie składowe od `head` (bez zdań podrzędnych w `stop`); „nieprawda, że X” = ¬X, „wiadomo, że X” = X."""
    lem = (T.t(head)["lemma"] or "").lower()
    if lem in WRAP:
        # rozbiór bywa płaski („wiadomo, że nieprawda, że X” → oba jako ccomp „wiadomo”), więc treść bierzemy z ciągu
        # wyrazów po ostatnim „że” poddrzewa; przeczeń tyle, ile „nieprawda” przed nim
        sub = T.sub(head, set(stop or ()))
        marks = [i for i in sub if T.t(i)["deprel"] == "mark" and T.t(i)["upos"] == "SCONJ"]
        if not marks:
            return None
        m = max(marks)
        span = [i for i in sub if i > m]
        x = _lit(T, head, set(), span)
        nneg = sum(1 for i in sub if (T.t(i)["lemma"] or "").lower() == "nieprawda" and i < m)
        return (x.neg() if nneg % 2 else x) if x else None
    return _lit(T, head, set(stop or ()))


def split_cond(s: str, T: Tree) -> tuple[str, str] | None:
    """Zdanie zaczynające się od spójnika podrzędnego (UPOS SCONJ, ew. po przysłówku) i z przecinkiem →
    (poprzednik, następnik). Zapas na płaskie rozbiory; spójnik rozpoznaje model (UPOS), nie lista słów."""
    toks = T.toks
    k = 1 if toks and toks[0]["upos"] == "ADV" else 0
    if len(toks) <= k or toks[k]["upos"] != "SCONJ" or "," not in s:
        return None
    a, b = s.split(",", 1)
    a = " ".join(a.split()[k + 1 :])
    b = re.sub(r"^\s*to\s+", "", b.strip())
    return (a + ".", b) if a and b else None


def rules_and_fact(T: Tree, s: str = "", parse=None) -> tuple[list[tuple[Lit, Lit]], list[Lit]]:
    """Zdanie oznajmujące → reguły (advcl→główne) albo fakt."""
    sc = split_cond(s, T) if parse else None
    if sc:
        Ta, Tb = Tree(parse(sc[0])["tokens"]), Tree(parse(sc[1])["tokens"])
        a, b = literal(Ta, Ta.root()), literal(Tb, Tb.root())
        return ([(a, b)] if a and b else []), []
    r = T.root()
    adv = [
        c
        for c in T.kids.get(r, [])
        if analiza.base(T.t(c)["deprel"]) == "advcl"
        and T.t(c)["part"] == "orzeczenie"
        or analiza.base(T.t(c)["deprel"]) == "advcl"
        and T.t(c)["upos"] in ("VERB", "ADJ", "NOUN")
    ]
    if adv:
        a = literal(T, adv[0])
        b = literal(T, r, set(adv))
        return ([(a, b)] if a and b else []), []
    x = literal(T, r)
    return [], ([x] if x else [])


def closure(facts: set[Lit], rules: list[tuple[Lit, Lit]]) -> set[Lit]:
    f = set(facts)
    for _ in range(10):
        n = len(f)
        for a, b in rules:
            if a in f:
                f.add(b)
            if b.neg() in f:
                f.add(a.neg())
        if len(f) == n:
            break
    return f


# ------------------------------------------------------------------ kwantyfikatory
def quant(T: Tree) -> tuple[str, str, frozenset, bool] | None:
    """(Q, klasa, orzeczenie, orzecznik_rzeczownikowy) – Q znormalizowane do all/some/none/notall."""
    for t in T.toks:
        f = t["form"].lower()
        prev = T.t(t["i"] - 1)["form"].lower() if t["i"] > 1 else ""
        q = next((v for k, v in Q_WORDS if (prev + " " + f).startswith(k) or f.startswith(k)), None)
        if not q:
            continue
        if prev == "nie" and q == "all":
            q = "notall"
        cls_i = (
            t["head"]
            if t["head"] and T.t(t["head"])["upos"] in ("NOUN", "PROPN")
            else (t["i"] if t["upos"] == "NOUN" else None)
        )
        if cls_i is None:  # „każdy osobnik” itp. – klasa = najbliższy rzeczownik po kwantyfikatorze
            cls_i = next((x["i"] for x in T.toks[t["i"] :] if x["upos"] == "NOUN"), None)
        if cls_i is None:
            return None
        cls = stem(T.t(cls_i)["lemma"])
        r = T.root()
        pred = T.t(r)
        qneg = {t["i"] - 1} if prev == "nie" else set()
        neg = any(
            T.t(c)["part"] == "przeczenie" and c not in qneg
            for c in T.kids.get(r, []) + [x for w in T.kids.get(r, []) for x in T.kids.get(w, [])]
        )
        if T.t(r)["i"] == cls_i:
            return None
        nominal = pred["upos"] in ("NOUN", "PROPN") and stem(pred["lemma"]) != cls
        skip = {cls_i, t["i"]} | ({t["i"] - 1} if prev == "nie" else set())
        key = frozenset(
            stem(x["lemma"]) for x in T.toks
            if x["i"] not in skip and x["upos"] not in DROP_UPOS and (x["lemma"] or "").lower() not in DROP_LEM
            and not x["form"].lower().startswith(("osobni", "każd", "czy"))
        )  # fmt: skip
        if q == "none":
            neg = False  # „żadne X nie są P” – podwójne przeczenie w polszczyźnie
        if neg:
            q = {"all": "none", "some": "notall", "notall": "some", "none": "all"}[q]
        return q, cls, key, nominal
    return None


SQUARE = {
    ("all", "all"): "tak", ("all", "some"): "tak", ("all", "none"): "nie", ("all", "notall"): "nie",
    ("none", "all"): "nie", ("none", "some"): "nie", ("none", "none"): "tak", ("none", "notall"): "tak",
    ("some", "all"): "nie wiadomo", ("some", "some"): "tak", ("some", "none"): "nie", ("some", "notall"): "nie wiadomo",
    ("notall", "all"): "nie", ("notall", "some"): "nie wiadomo", ("notall", "none"): "nie wiadomo", ("notall", "notall"): "tak",
}  # fmt: skip
INCOMPATIBLE = {
    ("all", "none"),
    ("none", "all"),
    ("all", "notall"),
    ("notall", "all"),
    ("some", "none"),
    ("none", "some"),
}


def _ant(key: frozenset) -> frozenset:
    m = {stem(a): stem(b) for a, b in ANT.items()}
    return frozenset(m.get(k, k) for k in key)


# ------------------------------------------------------------------ rozumowanie
@dataclass
class Reasoner:
    parse: Parser
    trace: list[str] = field(default_factory=list)

    def tree(self, s: str) -> Tree:
        return Tree(self.parse(s)["tokens"])

    def answer(self, question: str) -> str | None:
        self.trace = []
        sents = sentences(question)
        if not sents:
            return None
        qs = [s for s in sents if s.endswith("?")]
        if not qs:
            return None
        body, q = [s for s in sents if s is not qs[-1]], qs[-1]
        try:
            if "„" in q and "”" in q:
                return self.contradiction(q)
            ql = q.lower()
            if re.match(r"^(kto|komu)\b", ql):
                return self.who(body, q)
            if ql.startswith("czy"):
                return self.yesno(body, q)
        except (StopIteration, IndexError, KeyError):
            return None
        return None

    # --- tak / nie / nie wiadomo
    def yesno(self, body: list[str], q: str) -> str | None:
        Ts = [self.tree(s) for s in body]
        Tq = self.tree(q)
        qq = quant(Tq)
        bq = [quant(T) for T in Ts]
        if qq or any(bq):
            return self.quantified(Ts, bq, Tq, qq)
        rules, facts = [], []
        for T, s in zip(Ts, body, strict=True):
            r, f = rules_and_fact(T, s, self.parse)
            rules += r
            facts += f
        ql = literal(Tq, Tq.root())
        if ql is None:
            return None
        self.trace.append(f"reguły {len(rules)}, fakty {len(facts)}")
        if not rules:
            asp = self.aspect(Ts, Tq)
            if asp:
                return asp
            if any(f.key == ql.key for f in facts):
                return "tak" if any(f == ql for f in facts) else "nie"
            return None
        known = {k for a, b in rules for k in (a.key, b.key)} | {f.key for f in facts}
        if ql.key not in known:
            return None
        cl = closure(set(facts), rules)
        if ql in cl:
            return "tak"
        if ql.neg() in cl:
            return "nie"
        return "nie wiadomo"

    def quantified(self, Ts, bq, Tq, qq) -> str | None:
        subset = {(c, next(iter(k))) for (Q, c, k, nom) in [x for x in bq if x] if Q == "all" and nom and len(k) == 1}
        if qq is None:  # sylogizm: fakt o osobie + zawieranie klas
            ql = literal(Tq, Tq.root())
            facts = []
            for T, x in zip(Ts, bq, strict=True):
                if x is None:
                    _r, f = rules_and_fact(T)
                    facts += f
            negq = [(T, x) for T, x in zip(Ts, bq, strict=True) if x and x[0] == "none"]
            if ql is None or not subset:
                return None
            for small, big in subset:
                for f in facts:
                    if f.pol and small in f.key and big in ql.key and f.key - {small} == ql.key - {big}:
                        return "tak"
                    if f.pol and big in f.key and small in ql.key and f.key - {big} == ql.key - {small}:
                        return "nie wiadomo"
                for _T, x in negq:  # „X nie hoduje żadnych Y”, pytanie o podklasę
                    if x[1] == big and small in ql.key and x[2] - {big} <= ql.key:
                        return "nie"
            return None
        Q, cls, key, _ = qq
        for x in bq:
            if not x or x[1] != cls:
                continue
            if x[2] == key:
                return SQUARE[(x[0], Q)]
            if x[0] == "all" and _ant(x[2]) == key:  # wszystkie małe → żadne duże
                return SQUARE[("none", Q)]
        return None

    def aspect(self, Ts: list[Tree], Tq: Tree) -> str | None:
        if len(Ts) != 1:
            return None
        T = Ts[0]
        r = T.root()
        a = (T.t(r)["feats"] or {}).get("Aspect")
        stopped = any((t["lemma"] or "").lower() == "przerwać" for t in T.toks)
        qa = (Tq.t(Tq.root())["feats"] or {}).get("Aspect")
        if qa != "Perf" or not a:
            return None
        if stopped:
            return "nie"
        return "tak" if a == "Perf" else "nie wiadomo"

    # --- sprzeczność
    def contradiction(self, q: str) -> str | None:
        parts = re.findall(r"„([^”]+)”", q)
        if len(parts) != 2:
            return None
        A, B = (self.tree(p + ".") for p in parts)
        qa, qb = quant(A), quant(B)
        if qa and qb:
            if qa[1] != qb[1] or qa[2] != qb[2]:
                return None
            return "nie" if (qa[0], qb[0]) in INCOMPATIBLE else "tak"
        la, lb = literal(A, A.root()), literal(B, B.root())
        if not la or not lb:
            return None
        return "nie" if la.key == lb.key and la.pol != lb.pol else "tak"

    # --- kto / komu
    def who(self, body: list[str], q: str) -> str | None:
        ql = q.lower()
        Ts = [self.tree(s) for s in body]
        if not Ts:
            return None
        if "pierwszy" in ql or "ostatni" in ql:
            return self.temporal(Ts, "ostatni" in ql)
        if "najwyższy" in ql or "najniższy" in ql:
            return self.ordering(Ts, "najwyższy" in ql)
        if len(Ts) != 1:
            return None
        T = Ts[0]
        names = [t for t in T.toks if t["upos"] in ("PROPN", "NOUN") and t["form"][:1].isupper()]
        if ql.startswith("komu"):
            c = [t for t in names if t["q"] == "KOMU"] or [t for t in names if (t["feats"] or {}).get("Case") == "Dat"]
        else:
            c = [t for t in names if t["part"] == "podmiot" and (t["feats"] or {}).get("Case", "Nom") == "Nom"]
            verb = T.t(T.root())
            g = (verb["feats"] or {}).get("Gender")
            if g and len(c) != 1:  # zgoda rodzaju orzeczenia i podmiotu (dał/dała) rozstrzyga szyk przestawiony
                cand = [
                    t
                    for t in names
                    if t["i"] != verb["i"]
                    and (t["feats"] or {}).get("Case") == "Nom"
                    and (t["feats"] or {}).get("Gender") == g
                ]
                c = cand if len(cand) == 1 else c
        if len(c) > 1 and any(t["upos"] == "PROPN" for t in c):
            c = [t for t in c if t["upos"] == "PROPN"]
        if len(c) != 1:
            return None
        return c[0]["lemma"]

    def temporal(self, Ts: list[Tree], last: bool) -> str | None:
        before: list[tuple[str, str]] = []
        for T in Ts:
            subj = [t for t in T.toks if t["part"] == "podmiot"]
            cmp_ = [
                t
                for t in T.toks[1:]
                if t["upos"] in ("PROPN", "NOUN")
                and t["form"][:1].isupper()
                and t["part"] != "podmiot"
                and t["head"] != 0
            ]
            if not any((t["lemma"] or "").lower() == "wcześnie" for t in T.toks) or len(subj) != 1 or len(cmp_) != 1:
                return None
            before.append((subj[0]["lemma"], cmp_[0]["lemma"]))
        people = {x for p in before for x in p}
        later = {b for _a, b in before}
        earlier = {a for a, _b in before}
        ends = sorted(people - (earlier if last else later))
        return ends[0] if len(ends) == 1 else None

    def ordering(self, Ts: list[Tree], hi: bool) -> str | None:
        vals: dict[str, int] = {}
        for T in Ts:
            nums = [t for t in T.toks if re.fullmatch(r"\d+", t["form"])]
            for nt in nums:
                prev = [
                    t
                    for t in T.toks[: nt["i"] - 1]
                    if t["upos"] == "PROPN" or t["part"] == "podmiot" and t["form"][:1].isupper()
                ]
                if not prev:
                    return None
                vals[prev[-1]["lemma"]] = int(nt["form"])
        if len(vals) < 2:
            return None
        return (max if hi else min)(vals, key=vals.get)
