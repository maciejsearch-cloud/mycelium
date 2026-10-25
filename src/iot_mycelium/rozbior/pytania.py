"""Pytania z rozbioru zdania – z odpowiedzią wyznaczoną z ramy, sprawdzaną programem (S2: samodzielne ćwiczenia).

Rodzaje: rola (Kto? Komu? Gdzie? …), przydawka (Jaki dom…?), orzecznik (Jaki był dom?), orzeczenie (Co robi X?),
tak/nie z przeczenia (Czy …?), wnioskowanie z czasowników przekazania z Walentego (Kto ma teraz książkę?).
Źródło zdań: wyłącznie podziały train UD (nigdy test). Wynik = selfplay.Task (kind „rozbiór: …”, options = słowa-głowy
argumentów z tej ramy, więc sprawdzarka selfplay.check działa bez zmian).
"""

from __future__ import annotations

import random
from typing import Any

from ..mesh.selfplay import Task
from . import analiza

QW = {
    "KTO/CO": ("Kto", "Co"),
    "KOGO/CO": ("Kogo", "Co"),
    "KOGO/CZEGO": ("Kogo", "Czego"),
    "KOMU/CZEMU": ("Komu", "Czemu"),
    "KIM/CZYM": ("Kim", "Czym"),
    "O KIM/O CZYM": ("O kim", "O czym"),
}
ADVQ = {"GDZIE": "Gdzie", "KIEDY": "Kiedy", "DOKĄD": "Dokąd", "SKĄD": "Skąd", "DLACZEGO": "Dlaczego", "PO CO": "Po co"}
NEG_WORDS = set(["nigdy", "nikt", "nic", "żaden", "nigdzie", "nijak", "niczyj", "ani"])
ABSTRACT_LOC = set(
    [
        "kwestia",
        "sprawa",
        "przypadek",
        "rama",
        "zakres",
        "dziedzina",
        "sytuacja",
        "stan",
        "warunek",
        "okres",
        "czas",
        "sens",
        "charakter",
        "rola",
        "wymiar",
        "wypadek",
        "obliczu",
        "imię",
        "temat",
        "aspekt",
        "kontekst",
        "zasada",
        "forma",
        "sposób",
        "stopień",
        "wysokość",
        "poziom",
        "celu",
        "skala",
    ]
)
HUM_N = set(
    [
        "kobieta",
        "dziewczyna",
        "dziewczynka",
        "dziecko",
        "osoba",
        "matka",
        "mama",
        "córka",
        "siostra",
        "babcia",
        "żona",
        "pani",
        "nauczycielka",
        "lekarka",
        "uczennica",
        "studentka",
        "koleżanka",
        "przyjaciółka",
        "ciocia",
        "niemowlę",
        "pielęgniarka",
        "zawodniczka",
        "tancerka",
        "autorka",
        "właścicielka",
        "bohaterka",
        "królowa",
        "księżniczka",
        "wnuczka",
        "artystka",
        "piosenkarka",
        "aktorka",
        "policjantka",
        "sąsiadka",
        "narzeczona",
        "dama",
        "panna",
        "staruszka",
        "pracownica",
        "sportowczyni",
        "mistrzyni",
        "gospodyni",
        "pani",
        "rodzina",
        "para",
        "młodzież",
        "ludzie",
        "dzieci",
    ]
)
WH = {"co", "kto", "który", "jaki", "gdzie", "kiedy", "czyj", "ile", "dlaczego", "czemu", "jak", "dokąd", "skąd"}
PRON_HUM = {"ja", "ty", "on", "ona", "my", "wy", "oni", "one", "kto", "ktoś", "nikt", "każdy", "wszyscy", "siebie"}
# jaki / który / czyj: (przypadek, liczba, rodzaj) → końcówka po temacie (jak-/któr-/czyj-)
_END = {
    ("Nom", "Sing", "m"): ("i", "y", ""),
    ("Nom", "Sing", "f"): ("a", "a", "a"),
    ("Nom", "Sing", "n"): ("ie", "e", "e"),
    ("Nom", "Plur", "h"): ("cy", "zy", "i"),
    ("Nom", "Plur", "x"): ("ie", "e", "e"),
    ("Gen", "Sing", "m"): ("iego", "ego", "ego"),
    ("Gen", "Sing", "n"): ("iego", "ego", "ego"),
    ("Gen", "Sing", "f"): ("iej", "ej", "ej"),
    ("Gen", "Plur", "*"): ("ich", "ych", "ich"),
    ("Dat", "Sing", "m"): ("iemu", "emu", "emu"),
    ("Dat", "Sing", "n"): ("iemu", "emu", "emu"),
    ("Dat", "Sing", "f"): ("iej", "ej", "ej"),
    ("Dat", "Plur", "*"): ("im", "ym", "im"),
    ("Acc", "Sing", "ma"): ("iego", "ego", "ego"),
    ("Acc", "Sing", "m"): ("i", "y", ""),
    ("Acc", "Sing", "f"): ("ą", "ą", "ą"),
    ("Acc", "Sing", "n"): ("ie", "e", "e"),
    ("Acc", "Plur", "h"): ("ich", "ych", "ich"),
    ("Acc", "Plur", "x"): ("ie", "e", "e"),
    ("Ins", "Sing", "m"): ("im", "ym", "im"),
    ("Ins", "Sing", "n"): ("im", "ym", "im"),
    ("Ins", "Sing", "f"): ("ą", "ą", "ą"),
    ("Ins", "Plur", "*"): ("imi", "ymi", "imi"),
    ("Loc", "Sing", "m"): ("im", "ym", "im"),
    ("Loc", "Sing", "n"): ("im", "ym", "im"),
    ("Loc", "Sing", "f"): ("iej", "ej", "ej"),
    ("Loc", "Plur", "*"): ("ich", "ych", "ich"),
}
STEM = {"JAKI": ("jak", 0), "KTÓRY": ("któr", 1), "CZYJ": ("czyj", 2)}


def wh_adj(word: str, feats: dict[str, str]) -> str | None:
    """Forma „jaki/który/czyj” zgodna z rzeczownikiem (przypadek, liczba, rodzaj, żywotność)."""
    stem, k = STEM[word]
    case, num, gen, an = feats.get("Case"), feats.get("Number", "Sing"), feats.get("Gender"), feats.get("Animacy")
    if not case or case == "Voc":
        return None
    if num == "Plur":
        g = "h" if gen == "Masc" and an == "Hum" else "x"
        e = _END.get((case, "Plur", g)) or _END.get((case, "Plur", "*"))
    else:
        g = {"Masc": "m", "Fem": "f", "Neut": "n"}.get(gen or "")
        if not g:
            return None
        if case == "Acc" and g == "m" and an in ("Hum", "Anim"):
            g = "ma"
        e = _END.get((case, "Sing", g))
    if not e:
        return None
    if num == "Plur" and case == "Nom" and g == "h":
        return {"JAKI": "jacy", "KTÓRY": "którzy", "CZYJ": "czyi"}[word]
    return stem + e[k]


def _animate(t: dict[str, Any]) -> bool:
    f = t.get("feats") or {}
    if t["upos"] == "PROPN":
        return True
    if t["upos"] == "PRON":
        return (t.get("lemma") or "").lower() in PRON_HUM
    lem = (t.get("lemma") or "").lower()
    return (
        (f.get("Gender") == "Masc" and f.get("Animacy") in ("Hum", "Anim", "Nhum"))
        or lem in HUM_N
        or lem.endswith(("yni", "ini"))
    )


def _join(forms: list[str], glue: list[bool] | None = None) -> str:
    s = "".join(w + ("" if g else " ") for w, g in zip(forms, glue, strict=False)).strip() if glue else " ".join(forms)
    for p in (" ,", " .", " ;", " :", " !", " ?", " )"):
        s = s.replace(p, p[1:])
    return s.replace("( ", "(")


def _lc(t: dict[str, Any], s: str) -> str:
    return s if t["upos"] == "PROPN" or (s.isupper() and len(s) > 1) else s[:1].lower() + s[1:]


class Ctx:
    def __init__(self, toks: list[dict[str, Any]], a: dict[str, Any]):
        self.toks, self.a = toks, a
        self.T = analiza.Tree(toks)
        self.parts = a["tokens"]

    def form(self, i: int) -> str:
        return self.toks[i - 1]["form"]

    def text(self, ids: list[int], front: str = "") -> str:
        """Słowa w kolejności zdania; pierwsze słowo zdania małą literą (chyba że nazwa własna), klityki doklejone."""
        first = next((t["i"] for t in self.parts if t["part"] != "interpunkcja"), 1)
        ws = [_lc(self.toks[i - 1], self.form(i)) if i == first else self.form(i) for i in ids]
        glue = [ids[k + 1] == ids[k] + 1 and self.toks[ids[k] - 1].get("sa") == 0 for k in range(len(ids) - 1)] + [
            False
        ]
        body = _join(ws, glue)
        return f"{front} {body}".strip() if front else body

    def clause_tokens(self, f: dict[str, Any]) -> list[int]:
        c = f["clause"]
        ids = [t["i"] for t in self.parts if t["clause"] == c and t["part"] != "interpunkcja"]
        while ids and (
            self.parts[ids[0] - 1]["part"] in ("spójnik", "partykuła")
            or (self.toks[ids[0] - 1].get("lemma") or "").lower() in analiza.MARK_TYPE
        ):
            ids = ids[1:]
        return ids

    def span(self, a: dict[str, Any]) -> list[int]:
        lo, hi = a["span"]
        return [i for i in range(lo, hi + 1) if self.parts[i - 1]["part"] != "interpunkcja"]


def _ok_subject_agreement(ctx: Ctx, f: dict[str, Any], who: bool) -> bool:
    v = next((w for w in f["words"] if (ctx.toks[w - 1].get("feats") or {}).get("Number")), f["pred"])
    fe = ctx.toks[v - 1].get("feats") or {}
    if fe.get("Number") == "Plur":
        return False
    if fe.get("Tense") == "Past" or fe.get("VerbForm") == "Part":
        g = fe.get("Gender")
        return g == ("Masc" if who else "Neut")
    return fe.get("Person", "3") == "3"


def _qword(g: dict[str, Any], t: dict[str, Any]) -> str | None:
    q = g["q"] or ""
    if q in QW:
        return QW[q][0 if _animate(t) else 1].lower()
    if q in ADVQ:
        return ADVQ[q].lower()
    if len(q.split()) == 2 and "/" in q:
        prep, cq = q.split(" ", 1)
        who, what = cq.split("/")
        return f"{prep} {(who if _animate(t) else what)}".lower()
    return q.lower() or None


def _relative(ctx: Ctx, body: list[int]) -> bool:
    """Zdanie względne („…, które często zdobią …”) – pytanie z niego bez zdania nadrzędnego traci sens."""
    return any(
        {"Rel", "Int"} & set(((ctx.toks[i - 1].get("feats") or {}).get("PronType") or "").split(","))
        or (ctx.toks[i - 1].get("lemma") or "").lower() in ("który", "jaki", "czyj", "co", "kto", "gdzie", "kiedy")
        and ctx.T.rel(i) not in ("root",)
        and i != body[0]
        for i in body
    )


def questions(
    toks: list[dict[str, Any]], a: dict[str, Any] | None = None, text: str = "", transfer: set[str] | None = None
) -> list[dict[str, Any]]:
    """Wszystkie pytania z jednej analizy. Każde: kind, question, answer, accept[], options[], level, src."""
    a = a or analiza.analyse(toks)
    ctx = Ctx(toks, a)
    out: list[dict[str, Any]] = []
    # pytania tylko ze zdań oznajmujących (z pytania „kto zbudował bombę?” nie wynika, kto ją zbudował)
    if any(t["form"] == "?" for t in toks):
        return out
    ctype = {c["id"]: c["type"] for c in a["clauses"]}
    for f in a["frames"]:
        body = ctx.clause_tokens(f)
        if not any(ctx.toks[w - 1]["upos"] in ("VERB", "AUX") for w in f["words"]):
            continue
        if (ctx.toks[f["pred"] - 1].get("feats") or {}).get("VerbForm") == "Conv":
            continue  # imiesłów przysłówkowy („tworząc …”) – bez własnego podmiotu
        if body and (ctx.toks[body[0] - 1].get("lemma") or "").lower() in WH:
            continue
        if _relative(ctx, body):
            continue
        heads = [g["i"] for g in f["args"]]
        opts = sorted({ctx.form(i) for i in heads} | {ctx.form(f["pred"])})
        cand: list[dict[str, Any]] = []
        # pytajniki wszystkich argumentów (także pomijanych): „Co przypomina mi to?” – „co” = podmiot „to” i „czasy”
        allq = [_qword(g, ctx.toks[g["i"] - 1]) for g in f["args"]]
        for g in f["args"]:
            sp = set(ctx.span(g))
            rest = [i for i in body if i not in sp]
            if len([i for i in rest if ctx.toks[i - 1]["upos"] != "PUNCT"]) < 2 or len(sp) > 8:
                continue  # „Co jest?” – za mało treści, żeby pytanie było jednoznaczne
            if any(ctx.T.children(c, "fixed") for c in ctx.T.children(g["i"], "case")):
                continue  # przyimek złożony („z tyłu”, „w głębi”) – pytanie z samego przyimka byłoby złe
            if (g["q"] or "").split(" ")[0] in ("OKOŁO", "PONAD", "BLISKO", "PRAWIE"):
                continue  # „około stu meteorów” – to liczebnik przybliżony, nie okolicznik
            t = ctx.toks[g["i"] - 1]
            if (t.get("lemma") or "").lower() in WH or ctx.T.children(g["i"], "conj") or ctx.T.rel(g["i"]) == "conj":
                continue
            # zaimek osobowy jako odpowiedź („je”, „go”) wskazuje na coś spoza zdania – nie sprawdzisz go z tekstu
            if t["upos"] == "PRON" and (t.get("feats") or {}).get("PronType") in ("Prs", "Dem"):
                continue
            if g["q"] in ("PO CO", "DLACZEGO") and (_animate(t) or t["upos"] == "PRON"):
                continue  # „dla mnie” to nie cel ani przyczyna
            if g["q"] in ("GDZIE", "DOKĄD", "SKĄD") and (
                t["upos"] not in ("NOUN", "PROPN") or _animate(t) or (t.get("lemma") or "").lower() in ABSTRACT_LOC
            ):
                continue  # „patrzył na Petera”, „w tej kwestii” – to nie miejsce
            if g["part"] == "podmiot" and t["upos"] not in ("NOUN", "PROPN", "PRON", "NUM"):
                continue
            if g["q"] in QW:
                anim = _animate(t)
                qw = QW[g["q"]][0 if anim else 1]
                if g["part"] == "podmiot" and not _ok_subject_agreement(ctx, f, anim):
                    continue
                # podmiot w dopełniaczu („następcy zabraknie”, „dziewięciu wioślarzy”) – „Kto?” byłoby fałszywe
                if g["part"] == "podmiot" and (t.get("feats") or {}).get("Case", "Nom") != "Nom":
                    continue
            elif g["q"] in ADVQ:
                qw = ADVQ[g["q"]]
            elif (
                " " in g["q"]
                and g["q"].split(" ", 1)[1] in ("KIM/CZYM", "KOGO/CO", "KOGO/CZEGO", "KOMU/CZEMU")
                and len(g["q"].split()) == 2
            ):
                prep, cq = g["q"].split(" ", 1)
                who, what = cq.split("/")
                qw = prep.capitalize() + " " + (who if _animate(t) else what).lower()
            else:
                continue
            q = ctx.text(rest, qw) + "?"
            ans = ctx.form(g["i"])
            cand.append(
                {
                    "qw": qw.lower(),
                    "kind": "rola",
                    "q_role": g["q"],
                    "question": q,
                    "answer": ans,
                    "accept": sorted({ans, t.get("lemma") or ans, _join([ctx.form(i) for i in sorted(sp)])}),
                    "options": opts if ans in opts else sorted({*opts, ans}),
                    "level": 1,
                    "src": [f["pred"], g["q"], g["i"]],
                }
            )
        # dwa argumenty z tym samym pytaniem („Gdzie siedzi? – pod parasolem / na kocu”) = niejednoznaczne, odpadają
        out += [{k: v for k, v in c.items() if k != "qw"} for c in cand if allq.count(c["qw"]) == 1]
        # tak/nie: przeczenie orzeczenia
        neg_toks = {t["i"] for t in ctx.parts if t["part"] == "przeczenie" and ctx.T.head(t["i"]) in f["words"]}
        rest = [i for i in body if i not in neg_toks]
        finite = any((ctx.toks[w - 1].get("feats") or {}).get("VerbForm") == "Fin" for w in f["words"])
        main = ctype.get(f["clause"], "").startswith(("główne", "współrzędne", "podrzędne dopełnieniowe"))
        # „nigdy bym nie usunęła”, „nie znałem kościoła” – bez „nie” zdanie jest niegramatyczne (zaimek przeczący,
        # dopełniacz przeczenia), więc pytanie tak/nie powstaje tylko, gdy zdanie bez przeczenia brzmi poprawnie
        neg_words = any((ctx.toks[i - 1].get("lemma") or "").lower() in NEG_WORDS for i in rest)
        gen_neg = f["neg"] and any(
            g["part"] == "dopełnienie" and (ctx.toks[g["i"] - 1].get("feats") or {}).get("Case") == "Gen"
            for g in f["args"]
        )
        if 2 <= len(rest) <= 14 and f["kind"] == "czasownikowe" and finite and main and not neg_words and not gen_neg:
            out.append(
                {
                    "kind": "przeczenie",
                    "question": ctx.text(rest, "Czy") + "?",
                    "answer": "nie" if f["neg"] else "tak",
                    "accept": ["nie" if f["neg"] else "tak"],
                    "options": ["tak", "nie"],
                    "level": 1,
                    "src": [f["pred"], "NIE", 0],
                }
            )
        # orzecznik przymiotnikowy: „Jaki był dom?”
        pt = ctx.toks[f["pred"] - 1]
        subj = next((g for g in f["args"] if g["part"] == "podmiot"), None)
        if f["kind"] == "imienne" and pt["upos"] == "ADJ" and subj and not f["neg"]:
            w = wh_adj("JAKI", {**(pt.get("feats") or {}), "Case": "Nom"})
            cop = [i for i in f["words"] if i != f["pred"]]
            sp = ctx.span(subj)
            if w and cop and len(sp) <= 6:
                q = ctx.text(cop + sp, w.capitalize()) + "?"
                out.append(
                    {
                        "kind": "orzecznik",
                        "question": q,
                        "answer": pt["form"],
                        "accept": [pt["form"], pt.get("lemma") or pt["form"]],
                        "options": opts,
                        "level": 1,
                        "src": [f["pred"], "ORZECZNIK", f["pred"]],
                    }
                )
        # wnioskowanie: czasownik przekazania (Walenty) w czasie przeszłym, aspekt dokonany, bez przeczenia
        lem = (pt.get("lemma") or "").lower()
        if transfer and lem in transfer and not f["neg"] and f["aspect"] == "Perf" and f["tense"] == "Past":
            rec = next((g for g in f["args"] if g["q"] == "KOMU/CZEMU"), None)
            obj = next((g for g in f["args"] if g["q"] == "KOGO/CO"), None)
            ok_pos = (
                rec
                and obj
                and ctx.toks[rec["i"] - 1]["upos"] in ("NOUN", "PROPN")
                and ctx.toks[obj["i"] - 1]["upos"] == "NOUN"
            )
            if ok_pos and len(ctx.span(obj)) <= 5:
                r_ = ctx.toks[rec["i"] - 1]
                lemma = r_.get("lemma") or r_["form"]
                out.append(
                    {
                        "kind": "wnioskowanie",
                        "question": ctx.text(ctx.span(obj), "Kto ma teraz") + "?",
                        "answer": lemma,
                        "accept": sorted({lemma, r_["form"]}),
                        "options": sorted(
                            {
                                (ctx.toks[g["i"] - 1].get("lemma") or ctx.form(g["i"]))
                                for g in f["args"]
                                if g["part"] != "okolicznik"
                            }
                        ),
                        "level": 3,
                        "src": [f["pred"], "MA TERAZ", rec["i"]],
                        "why": f"„{lem}” (Walenty: przekazanie – KTO daje KOMU CO) w aspekcie dokonanym, czas przeszły → odbiorca ma teraz przedmiot",
                    }
                )
    # przydawki: „Jaki dom stał na wzgórzu?”
    for t in ctx.parts:
        if t["part"] != "przydawka" or t["q"] not in STEM or not t["of"]:
            continue
        x, h = ctx.toks[t["i"] - 1], t["of"]
        if x["upos"] != "ADJ" or ctx.toks[h - 1]["upos"] not in ("NOUN", "PROPN"):
            continue
        # jedna przydawka przymiotna przy rzeczowniku – inaczej „Jaką bombę?” ma dwie odpowiedzi (radziecką, atomową)
        if len(ctx.T.children(h, "amod", "det")) != 1:
            continue
        f = next((fr for fr in a["frames"] if any(g["i"] == h for g in fr["args"])), None)
        if (
            not f
            or (ctx.toks[f["pred"] - 1].get("feats") or {}).get("VerbForm") == "Conv"
            or _relative(ctx, ctx.clause_tokens(f))
            or ctx.T.rel(h) == "conj"
            or ctx.T.children(h, "conj")
        ):
            continue
        # imiesłów albo przymiotnik z własnymi określeniami („grający na saksofonie”) – pytanie byłoby pokręcone
        if (x.get("feats") or {}).get("VerbForm") or ctx.T.children(t["i"]):
            continue
        w = wh_adj(t["q"], ctx.toks[h - 1].get("feats") or {})
        if not w:
            continue
        body = ctx.clause_tokens(f)
        # fraza rzeczownika (z przyimkiem), bez badanej przydawki
        top = h
        sub = set(ctx.T.subtree(top, stop=frozenset(set(range(1, ctx.T.n + 1)) - set(body))))
        sub = {i for i in sub if i in body}
        if len(sub) > 7:
            continue
        phrase = [i for i in sorted(sub) if i != t["i"]]
        case = [i for i in phrase if ctx.parts[i - 1]["part"] == "przyimek" and ctx.T.head(i) == h]
        case += [i for i in phrase if ctx.T.head(i) in case and ctx.T.rel(i) == "fixed"]  # „w pobliżu”, „na temat”
        case.sort()
        noun_phrase = [i for i in phrase if i not in case]
        front = " ".join(
            [ctx.form(i).lower() for i in case] + [w] + [_lc(ctx.toks[i - 1], ctx.form(i)) for i in noun_phrase]
        )
        rest = [i for i in body if i not in sub]
        if not rest:
            continue
        q = ctx.text(rest, front) + "?"
        q = q[:1].upper() + q[1:]
        out.append(
            {
                "kind": "przydawka",
                "q_role": t["q"],
                "question": q,
                "answer": x["form"],
                "accept": sorted({x["form"], x.get("lemma") or x["form"]}),
                "options": sorted(
                    {
                        ctx.form(p["i"])
                        for p in ctx.parts
                        if p["part"] == "przydawka" and ctx.toks[p["i"] - 1]["upos"] in ("ADJ", "DET")
                    }
                ),
                "level": 2,
                "src": [h, t["q"], t["i"]],
            }
        )
    return out


def to_tasks(items: list[dict[str, Any]], text: str) -> list[Task]:
    """Do samodzielnych ćwiczeń: zdanie jako kontekst, odpowiedź jednym słowem z opcji."""
    out = []
    for it in items:
        if it["kind"] == "przeczenie":
            q = f"Zdanie: „{text}” Pytanie: {it['question']} Odpowiedz: tak albo nie."
            out.append(Task(f"rozbiór: {it['kind']}", q, it["answer"], it["level"]))
            continue
        if len(it["options"]) < 2 or it["answer"] not in it["options"] or any(" " in o for o in it["options"]):
            continue
        q = f"Zdanie: „{text}” Pytanie: {it['question']} Odpowiedz jednym słowem z tego zdania."
        out.append(Task(f"rozbiór: {it['kind']}", q, it["answer"], it["level"], tuple(it["options"])))
    return out


def sample(
    sents: list[dict[str, Any]],
    n: int,
    seed: int,
    transfer: set[str] | None = None,
    max_len: int = 20,
    exclude: set[str] | None = None,
    gate_ngrams: set | None = None,
) -> list[Task]:
    """n zadań z losowych zdań (tylko podział train), rodzaje wymieszane, tak/nie po równo.
    exclude / gate_ngrams: odcisk i 8-gramy bramki 2000 pytań LM – pytanie pokrywające się z bramką odpada."""
    from ..mesh import selfplay as sp

    r = random.Random(seed)
    pool = [s for s in sents if len(s["toks"]) <= max_len]
    r.shuffle(pool)
    out: list[Task] = []
    yn = {"tak": 0, "nie": 0}
    for s in pool:
        items = questions(s["toks"], text=s["text"], transfer=transfer)
        r.shuffle(items)
        for t in to_tasks(items, s["text"])[:2]:
            if exclude and sp.qhash(t.question) in exclude:
                continue
            if gate_ngrams and sp.ngrams(t.question, 8) & gate_ngrams:
                continue
            if t.kind == "rozbiór: przeczenie":
                if yn[t.answer] > min(yn.values()):
                    continue
                yn[t.answer] += 1
            out.append(t)
        if len(out) >= n:
            break
    return out[:n]
