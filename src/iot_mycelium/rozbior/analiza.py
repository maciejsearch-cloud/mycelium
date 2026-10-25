"""Drzewo zależności (UD) → pełny rozbiór zdania po polsku.

Wejście: lista tokenów z polami form, lemma, upos, feats, head (1-based, 0 = korzeń), deprel – złote (z treebanku)
albo przewidziane przez model. Te same reguły liczą złoty rozbiór i rozbiór z modelu, więc role-F1 mierzy
wyłącznie jakość rozpoznania drzewa i cech (reguły nie są „uczone” na zbiorze testowym).

Wynik (JSON): tokens[] (część mowy, cechy po polsku, część zdania, pytanie, czego dotyczy przydawka, zdanie składowe),
clauses[] (główne / współrzędne / podrzędne … z spójnikiem), frames[] (orzeczenie + argumenty z pytaniem przypadku).
Lustro w TypeScripcie: web/src/myc/rozbior.ts (test zgodności: tests/test_rozbior.py + web/scripts/rozbior-parity).
"""

from __future__ import annotations

from typing import Any

POS_PL = {
    "NOUN": "rzeczownik",
    "PROPN": "rzeczownik własny",
    "VERB": "czasownik",
    "AUX": "czasownik posiłkowy",
    "ADJ": "przymiotnik",
    "ADV": "przysłówek",
    "PRON": "zaimek",
    "DET": "zaimek określający",
    "NUM": "liczebnik",
    "ADP": "przyimek",
    "CCONJ": "spójnik współrzędny",
    "SCONJ": "spójnik podrzędny",
    "PART": "partykuła",
    "INTJ": "wykrzyknik",
    "PUNCT": "interpunkcja",
    "SYM": "symbol",
    "X": "inne",
}
UPOS = list(POS_PL)

FEAT_PL = {
    "Case": {
        "Nom": "mianownik",
        "Gen": "dopełniacz",
        "Dat": "celownik",
        "Acc": "biernik",
        "Ins": "narzędnik",
        "Loc": "miejscownik",
        "Voc": "wołacz",
    },
    "Number": {"Sing": "liczba pojedyncza", "Plur": "liczba mnoga", "Ptan": "tylko mnoga"},
    "Gender": {"Masc": "rodzaj męski", "Fem": "rodzaj żeński", "Neut": "rodzaj nijaki"},
    "Animacy": {"Hum": "męskoosobowy", "Nhum": "niemęskoosobowy", "Anim": "żywotny", "Inan": "nieżywotny"},
    "Person": {"1": "1. osoba", "2": "2. osoba", "3": "3. osoba", "0": "bezosobowo"},
    "Tense": {"Past": "czas przeszły", "Pres": "czas teraźniejszy", "Fut": "czas przyszły"},
    "Aspect": {"Imp": "niedokonany", "Perf": "dokonany"},
    "Mood": {"Ind": "oznajmujący", "Imp": "rozkazujący", "Cnd": "przypuszczający"},
    "Degree": {"Pos": "stopień równy", "Cmp": "stopień wyższy", "Sup": "stopień najwyższy"},
    "VerbForm": {
        "Fin": "forma osobowa",
        "Inf": "bezokolicznik",
        "Part": "imiesłów",
        "Conv": "imiesłów przysłówkowy",
        "Vnoun": "rzeczownik odczasownikowy",
    },
    "Voice": {"Act": "strona czynna", "Pass": "strona bierna"},
    "Polarity": {"Pos": "twierdzenie", "Neg": "przeczenie"},
}
# cechy przewidywane przez model i liczone w mierze „cechy” (kolejność stała – też w modelu)
FEATS = list(FEAT_PL)

CASE_Q = {
    "Nom": "KTO/CO",
    "Gen": "KOGO/CZEGO",
    "Dat": "KOMU/CZEMU",
    "Acc": "KOGO/CO",
    "Ins": "KIM/CZYM",
    "Loc": "O KIM/O CZYM",
    "Voc": "WOŁACZ",
}
CASE_Q_PREP = {"Gen": "KOGO/CZEGO", "Dat": "KOMU/CZEMU", "Acc": "KOGO/CO", "Ins": "KIM/CZYM", "Loc": "KIM/CZYM"}
PREP_NORM = {
    "we": "w",
    "ze": "z",
    "ku": "ku",
    "ode": "od",
    "nade": "nad",
    "pode": "pod",
    "przede": "przed",
    "przeze": "przez",
    "beze": "bez",
    "spode": "spod",
    "obe": "o",
}

TIME_N = set(
    [
        "rok",
        "lata",
        "dzień",
        "doba",
        "tydzień",
        "miesiąc",
        "godzina",
        "minuta",
        "sekunda",
        "chwila",
        "moment",
        "czas",
        "okres",
        "wiek",
        "stulecie",
        "tysiąclecie",
        "era",
        "epoka",
        "noc",
        "ranek",
        "rano",
        "poranek",
        "wieczór",
        "popołudnie",
        "południe",
        "północ",
        "świt",
        "zmierzch",
        "weekend",
        "sezon",
        "semestr",
        "kwartał",
        "wiosna",
        "lato",
        "jesień",
        "zima",
        "poniedziałek",
        "wtorek",
        "środa",
        "czwartek",
        "piątek",
        "sobota",
        "niedziela",
        "styczeń",
        "luty",
        "marzec",
        "kwiecień",
        "maj",
        "czerwiec",
        "lipiec",
        "sierpień",
        "wrzesień",
        "październik",
        "listopad",
        "grudzień",
        "święto",
        "wakacje",
        "ferie",
        "urlop",
        "wojna",
        "początek",
        "koniec",
        "przeszłość",
        "przyszłość",
        "teraźniejszość",
        "dzieciństwo",
        "młodość",
        "starość",
        "dekada",
        "termin",
        "data",
        "pora",
        "godz",
        "okazja",
    ]
)
PLACE_PREP = set(
    [
        "w",
        "na",
        "przy",
        "pod",
        "nad",
        "za",
        "przed",
        "między",
        "pomiędzy",
        "obok",
        "u",
        "wśród",
        "pośród",
        "koło",
        "poza",
        "wokół",
        "naprzeciw",
        "naprzeciwko",
        "niedaleko",
        "wewnątrz",
        "opodal",
        "blisko",
        "dookoła",
    ]
)
TO_PREP = {"do", "ku"}
FROM_PREP = {"z", "od", "spod", "znad", "zza", "sprzed", "spośród", "spomiędzy"}
TIME_PREP = {"podczas", "około", "przed", "po", "od", "do", "w", "przez", "na", "za", "koło", "pod", "u", "z"}
CAUSE_PREP = {"dzięki", "wskutek", "wobec", "skutkiem"}
CAUSE_N = {"powód", "przyczyna", "skutek", "racja", "wynik", "względ"}

ADV_PLACE = set(
    [
        "tu",
        "tutaj",
        "tam",
        "gdzie",
        "wszędzie",
        "nigdzie",
        "gdzieś",
        "gdziekolwiek",
        "daleko",
        "blisko",
        "wysoko",
        "nisko",
        "obok",
        "wokół",
        "dookoła",
        "stąd",
        "stamtąd",
        "skąd",
        "dokąd",
        "dotąd",
        "tędy",
        "tamtędy",
        "wewnątrz",
        "zewnątrz",
        "naprzeciw",
        "naprzód",
        "wstecz",
        "dalej",
        "bliżej",
        "wyżej",
        "niżej",
        "niedaleko",
        "opodal",
        "dookoła",
        "góra",
        "dół",
        "nigdzie",
        "owdzie",
        "indziej",
    ]
)
ADV_TIME = set(
    [
        "teraz",
        "wczoraj",
        "dziś",
        "dzisiaj",
        "jutro",
        "pojutrze",
        "przedwczoraj",
        "zawsze",
        "nigdy",
        "często",
        "rzadko",
        "wtedy",
        "potem",
        "później",
        "wcześniej",
        "niedawno",
        "dawno",
        "kiedyś",
        "wkrótce",
        "zaraz",
        "natychmiast",
        "codziennie",
        "ostatnio",
        "obecnie",
        "dotychczas",
        "dopiero",
        "nadal",
        "wciąż",
        "ciągle",
        "odtąd",
        "wówczas",
        "kiedy",
        "kiedykolwiek",
        "kiedyś",
        "nieraz",
        "czasem",
        "czasami",
        "zazwyczaj",
        "zwykle",
        "rano",
        "wieczorem",
        "nocą",
        "latem",
        "zimą",
        "wiosną",
        "jesienią",
        "długo",
        "krótko",
        "prędko",
        "szybko",
        "wreszcie",
        "nareszcie",
        "znowu",
        "znów",
        "ponownie",
        "odtąd",
        "tymczasem",
        "dotąd",
        "dziennie",
        "rocznie",
        "corocznie",
        "właśnie",
    ]
)
ADV_CAUSE = {"dlatego", "dlaczego", "czemu", "przeto", "stąd", "zatem", "toteż"}
ADV_PURPOSE = {"celowo", "umyślnie", "naumyślnie", "specjalnie", "po co"}
ADV_DEGREE = set(
    [
        "bardzo",
        "trochę",
        "nieco",
        "zbyt",
        "za",
        "dość",
        "dosyć",
        "całkiem",
        "zupełnie",
        "całkowicie",
        "prawie",
        "niemal",
        "mniej",
        "więcej",
        "najbardziej",
        "najmniej",
        "tak",
        "aż",
    ]
)

MARK_TYPE = {
    "gdy": "czasu",
    "kiedy": "czasu",
    "zanim": "czasu",
    "aż": "czasu",
    "odkąd": "czasu",
    "dopóki": "czasu",
    "dopóty": "czasu",
    "ilekroć": "czasu",
    "skoro": "przyczyny",
    "bo": "przyczyny",
    "ponieważ": "przyczyny",
    "gdyż": "przyczyny",
    "albowiem": "przyczyny",
    "żeby": "celu",
    "aby": "celu",
    "by": "celu",
    "ażeby": "celu",
    "iżby": "celu",
    "gdzie": "miejsca",
    "dokąd": "miejsca",
    "skąd": "miejsca",
    "jeśli": "warunku",
    "jeżeli": "warunku",
    "gdyby": "warunku",
    "jeśliby": "warunku",
    "choć": "przyzwolenia",
    "chociaż": "przyzwolenia",
    "mimo": "przyzwolenia",
    "aczkolwiek": "przyzwolenia",
    "jak": "sposobu",
    "jakby": "sposobu",
    "niż": "porównania",
}
OKOL_Q = {
    "miejsca": "GDZIE",
    "kierunku": "DOKĄD",
    "skąd": "SKĄD",
    "czasu": "KIEDY",
    "sposobu": "JAK",
    "stopnia": "JAK BARDZO",
    "przyczyny": "DLACZEGO",
    "celu": "PO CO",
    "warunku": "POD JAKIM WARUNKIEM",
    "przyzwolenia": "MIMO CZEGO",
    "porównania": "JAK",
}
CC_TYPE = {
    "i": "łączne",
    "oraz": "łączne",
    "także": "łączne",
    "ani": "łączne",
    "ni": "łączne",
    "a": "przeciwstawne",
    "ale": "przeciwstawne",
    "lecz": "przeciwstawne",
    "jednak": "przeciwstawne",
    "jednakże": "przeciwstawne",
    "zaś": "przeciwstawne",
    "natomiast": "przeciwstawne",
    "albo": "rozłączne",
    "lub": "rozłączne",
    "czy": "rozłączne",
    "bądź": "rozłączne",
    "więc": "wynikowe",
    "zatem": "wynikowe",
    "dlatego": "wynikowe",
    "toteż": "wynikowe",
    "przeto": "wynikowe",
}

ARG_PARTS = {"podmiot", "dopełnienie", "okolicznik"}
PRED_AUX = {"aux", "aux:clitic", "aux:cnd", "aux:pass", "aux:imp", "expl:pv", "expl:impers"}
CLAUSE_REL = {
    "ccomp": "podrzędne dopełnieniowe",
    "ccomp:obj": "podrzędne dopełnieniowe",
    "ccomp:cleft": "podrzędne dopełnieniowe",
    "csubj": "podrzędne podmiotowe",
    "acl": "podrzędne przydawkowe",
    "acl:relcl": "podrzędne przydawkowe",
    "advcl": "podrzędne okolicznikowe",
    "advcl:relcl": "podrzędne okolicznikowe",
    "advcl:cmp": "podrzędne okolicznikowe",
    "parataxis": "współrzędne (bez spójnika)",
    "parataxis:obj": "wtrącone",
    "parataxis:insert": "wtrącone",
}


def base(rel: str) -> str:
    return rel.split(":")[0]


def feats_pl(feats: dict[str, str]) -> list[str]:
    out = []
    for k in FEATS:
        v = feats.get(k)
        if v and v in FEAT_PL[k]:
            out.append(FEAT_PL[k][v])
    return out


def _norm(s: str) -> str:
    s = (s or "").lower()
    return PREP_NORM.get(s, s)


class Tree:
    def __init__(self, toks: list[dict[str, Any]]):
        self.t = toks
        self.n = len(toks)
        self.kids: list[list[int]] = [[] for _ in range(self.n + 1)]  # 1-based, 0 = korzeń
        for i, x in enumerate(toks, 1):
            h = int(x.get("head") or 0)
            if not 0 <= h <= self.n or h == i:
                h = 0
            self.kids[h].append(i)

    def tok(self, i: int) -> dict[str, Any]:
        return self.t[i - 1]

    def rel(self, i: int) -> str:
        return self.tok(i).get("deprel") or "dep"

    def head(self, i: int) -> int:
        h = int(self.tok(i).get("head") or 0)
        return h if 0 <= h <= self.n and h != i else 0

    def f(self, i: int, k: str) -> str | None:
        return (self.tok(i).get("feats") or {}).get(k)

    def lem(self, i: int) -> str:
        return (self.tok(i).get("lemma") or self.tok(i).get("form") or "").lower()

    def children(self, i: int, *rels: str) -> list[int]:
        return [c for c in self.kids[i] if not rels or self.rel(c) in rels or base(self.rel(c)) in rels]

    def prep(self, i: int) -> str | None:
        """Przyimek frazy (dziecko 'case'), z przyimkami złożonymi typu „z powodu” → „z powodu”."""
        cs = self.children(i, "case")
        if not cs:
            return None
        c = cs[0]
        p = _norm(self.lem(c))
        fx = [self.lem(x) for x in self.children(c, "fixed")]
        return " ".join([p, *fx]) if fx else p

    def subtree(self, i: int, stop=frozenset()) -> list[int]:
        out, st, seen = [], [i], set()
        while st:
            j = st.pop()
            if j in seen:
                continue
            seen.add(j)
            out.append(j)
            for c in self.kids[j]:
                if c not in stop:
                    st.append(c)
        return sorted(out)

    def is_pred(self, i: int) -> bool:
        """Głowa zdania składowego: korzeń, czasownik osobowy/bezokolicznik albo fraza z łącznikiem."""
        up = self.tok(i).get("upos")
        r = base(self.rel(i))
        if self.children(i, "cop"):
            return True
        if up in ("VERB", "AUX") and (
            self.f(i, "VerbForm") in ("Fin", "Inf", "Part", None) or self.children(i, "aux", "nsubj")
        ):
            if self.f(i, "VerbForm") == "Part" and r in ("amod", "acl") and not self.children(i, "aux", "cop"):
                return r == "acl"
            return r not in ("amod", "nmod", "case", "mark", "cc", "fixed", "flat", "det")
        if r == "root" and up not in ("PUNCT",):
            return True
        return r in ("ccomp", "csubj", "advcl", "acl", "parataxis") and up not in ("PUNCT",)


def _okol_type(T: Tree, i: int, prep: str | None) -> str | None:
    lem = T.lem(i)
    case = T.f(i, "Case")
    if prep:
        p0 = prep.split()[0]
        if len(prep.split()) > 1 and prep.split()[1] in CAUSE_N:
            return "przyczyny"
        if p0 in CAUSE_PREP:
            return "przyczyny"
        if lem in CAUSE_N and p0 in ("z", "na"):
            return "przyczyny"
        if p0 == "dla" or (p0 == "w" and lem == "cel"):
            return "celu"
        if lem in TIME_N and p0 in TIME_PREP:
            return "czasu"
        if (
            T.tok(i).get("upos") == "NUM"
            and p0 in ("w", "od", "do", "po", "przed")
            and (T.tok(i).get("form") or "").isdigit()
        ):
            return "czasu"
        if p0 in ("podczas", "temu"):
            return "czasu"
        if p0 in TO_PREP or (p0 in ("w", "pod", "nad", "za", "przed", "między") and case == "Acc"):
            return "kierunku"
        if p0 in FROM_PREP and case == "Gen":
            return "skąd"
        if p0 in PLACE_PREP:
            return "miejsca"
        if p0 == "bez" or (p0 == "z" and case == "Ins"):
            return "sposobu"
        return None
    if lem in TIME_N and case in ("Acc", "Gen", "Ins"):
        return "czasu"
    return None


def _adv_type(T: Tree, i: int) -> str:
    lem = T.lem(i)
    if lem in ADV_PLACE:
        return "miejsca"
    if lem in ADV_TIME:
        return "czasu"
    if lem in ADV_CAUSE:
        return "przyczyny"
    if lem in ADV_PURPOSE:
        return "celu"
    if lem in ADV_DEGREE:
        return "stopnia"
    return "sposobu"


def _case_q(T: Tree, i: int, prep: str | None) -> str:
    case = T.f(i, "Case")
    up = T.tok(i).get("upos")
    if prep:
        q = CASE_Q_PREP.get(case or "", "KOGO/CO")
        if prep == "o" and case == "Loc":
            return "O KIM/O CZYM"
        return f"{prep.upper()} {q}"
    if up in ("VERB",) and T.f(i, "VerbForm") == "Inf":
        return "CO ROBIĆ"
    return CASE_Q.get(case or "", "KTO/CO" if up in ("NOUN", "PROPN", "PRON") else "CO")


def _attr_q(T: Tree, i: int) -> str:
    r = T.rel(i)
    up = T.tok(i).get("upos")
    if r in ("nmod:poss", "det:poss") or T.f(i, "Poss") == "Yes":
        return "CZYJ"
    if base(r) == "nummod" or up == "NUM" or r.startswith("det:num"):
        return "ILE"
    if up == "ADJ" and T.f(i, "NumType") == "Ord":
        return "KTÓRY"
    if up == "DET":
        return "KTÓRY"
    if base(r) == "nmod":
        p = T.prep(i)
        return f"JAKI ({_case_q(T, i, p)})" if p else "JAKI (KOGO/CZEGO)"
    if base(r) == "acl":
        return "JAKI (zdanie)"
    if base(r) == "appos":
        return "KTO/CO (dopowiedzenie)"
    return "JAKI"


def analyse(toks: list[dict[str, Any]]) -> dict[str, Any]:
    T = Tree(toks)
    n = T.n
    part: list[str | None] = [None] * (n + 1)
    q: list[str | None] = [None] * (n + 1)
    okol: list[str | None] = [None] * (n + 1)
    of: list[int | None] = [None] * (n + 1)
    preds = [i for i in range(1, n + 1) if T.is_pred(i)]
    pset = set(preds)

    # 1. części zdania (głowy fraz)
    for i in range(1, n + 1):
        r, br, up = T.rel(i), base(T.rel(i)), T.tok(i).get("upos")
        h = T.head(i)
        if br == "punct" or up == "PUNCT":
            part[i] = "interpunkcja"
        elif br == "case":
            part[i] = "przyimek"
        elif br in ("cc", "mark"):
            part[i] = "spójnik"
        elif r == "advmod:neg" or (up == "PART" and T.lem(i) == "nie"):
            part[i] = "przeczenie"
        elif br == "cop":
            part[i] = "łącznik"
        elif r in PRED_AUX:
            part[i] = "orzeczenie"
        elif br == "vocative":
            part[i] = "wołacz"
        elif br == "discourse" or up == "INTJ":
            part[i] = "wykrzyknik"
        elif r == "advmod:emph" or up == "PART":
            part[i] = "partykuła"
        elif i in pset and (br in ("root", "conj", "parataxis", "xcomp") or br in ("ccomp", "advcl", "acl", "csubj")):
            part[i] = "orzecznik" if T.children(i, "cop") else "orzeczenie"
        elif br in ("nsubj", "csubj"):
            part[i] = "podmiot"
            q[i] = "KTO/CO"
        elif br in ("obj", "iobj", "xcomp", "ccomp") or r in ("obl:arg", "nmod:arg", "obl:agent", "advmod:arg"):
            if r == "nmod:arg" and h not in pset:
                part[i] = "przydawka"
                of[i] = h
                q[i] = _attr_q(T, i)
            else:
                part[i] = "dopełnienie"
                q[i] = (
                    "CO (zdanie)"
                    if br == "ccomp"
                    else ("PRZEZ KOGO/CO" if r == "obl:agent" else _case_q(T, i, T.prep(i)))
                )
        elif br == "obl":
            part[i] = "okolicznik"
            p = T.prep(i)
            okol[i] = _okol_type(T, i, p)
            q[i] = OKOL_Q[okol[i]] if okol[i] in OKOL_Q and okol[i] not in ("sposobu",) else _case_q(T, i, p)
        elif br == "advmod":
            part[i] = "okolicznik"
            okol[i] = _adv_type(T, i)
            q[i] = OKOL_Q[okol[i]]
            if h not in pset:
                okol[i] = "stopnia" if okol[i] in ("sposobu", "stopnia") else okol[i]
                q[i] = OKOL_Q[okol[i]]
        elif br == "advcl":
            part[i] = "okolicznik"
            m = [T.lem(c) for c in T.children(i, "mark")]
            okol[i] = next((MARK_TYPE[x] for x in m if x in MARK_TYPE), None)
            q[i] = OKOL_Q.get(okol[i] or "", "W JAKICH OKOLICZNOŚCIACH")
        elif br in ("amod", "det", "nummod", "nmod", "acl", "appos"):
            part[i] = "przydawka"
            of[i] = h
            q[i] = _attr_q(T, i)
        elif br in ("fixed", "flat", "goeswith", "compound", "list", "orphan", "dep", "reparandum"):
            part[i] = None  # dziedziczy po głowie (krok 2)
        elif br == "conj":
            part[i] = None  # dziedziczy po pierwszym członie (krok 2)
        else:
            part[i] = "inne"

    # 2. dziedziczenie: człony współrzędne i wyrażenia wielowyrazowe przejmują funkcję głowy
    def inherit(i: int, depth: int = 0) -> None:
        if part[i] is not None or depth > n:
            return
        h = T.head(i)
        if h == 0:
            part[i] = "orzeczenie" if i in pset else "inne"
            return
        inherit(h, depth + 1)
        if base(T.rel(i)) == "conj" and i in pset and part[h] in ("orzeczenie", "orzecznik"):
            part[i] = "orzecznik" if T.children(i, "cop") else "orzeczenie"
            return
        part[i], q[i], okol[i], of[i] = part[h], q[h], okol[h], of[h]
        if base(T.rel(i)) == "conj" and part[i] in ("dopełnienie", "okolicznik", "podmiot"):
            p = T.prep(i) or T.prep(h)
            if part[i] == "okolicznik":
                okol[i] = _okol_type(T, i, p) or okol[h]
                q[i] = OKOL_Q[okol[i]] if okol[i] in OKOL_Q and okol[i] != "sposobu" else _case_q(T, i, p)

    for i in range(1, n + 1):
        inherit(i)

    # 3. zdania składowe
    def is_clause_head(i: int) -> bool:
        br = base(T.rel(i))
        if T.head(i) == 0:
            return True
        if T.rel(i) in CLAUSE_REL:
            return True
        return br == "conj" and i in pset and T.head(i) in clause_ids

    clause_ids: dict[int, int] = {}
    order = sorted(range(1, n + 1), key=lambda i: _depth(T, i))
    for i in order:
        if is_clause_head(i):
            clause_ids[i] = len(clause_ids)
    clauses = []
    for hd, cid in clause_ids.items():
        r = T.rel(hd)
        br = base(r)
        par = _clause_of(T, T.head(hd), clause_ids) if T.head(hd) else None
        if T.head(hd) == 0:
            typ, conj = "główne", None
        elif br == "conj":
            cc = [T.lem(c) for c in T.children(hd, "cc")]
            conj = cc[0] if cc else None
            typ = "współrzędne " + CC_TYPE.get(conj or "", "łączne" if conj else "(bez spójnika)")
            typ = typ.replace("współrzędne (bez spójnika)", "współrzędne bezspójnikowe")
        else:
            m = [T.lem(c) for c in T.children(hd, "mark")]
            conj = m[0] if m else None
            typ = CLAUSE_REL.get(r) or CLAUSE_REL.get(br) or "podrzędne"
            if typ == "podrzędne okolicznikowe" and okol[hd]:
                typ += f" {okol[hd]}"
        clauses.append({"id": cid, "head": hd, "type": typ, "conj": conj, "parent": par})
    clause_of = [None] + [_clause_of(T, i, clause_ids) for i in range(1, n + 1)]

    # 4. ramy orzeczeń
    frames = []
    for p in preds:
        if part[p] not in ("orzeczenie", "orzecznik"):
            continue
        words = sorted([p, *T.children(p, *PRED_AUX, "cop")])
        verb = next((c for c in T.children(p, "cop")), p)
        kind = "imienne" if T.children(p, "cop") else "czasownikowe"
        allw = [verb, *[c for c in words if c != verb]]
        aspect = next((T.f(w, "Aspect") for w in allw if T.f(w, "Aspect")), None)
        tense = next((T.f(w, "Tense") for w in allw if T.f(w, "Tense") and T.rel(w) != "aux:clitic"), None)
        mood = next((T.f(w, "Mood") for w in allw if T.f(w, "Mood") and T.f(w, "Mood") != "Ind"), None)
        if T.children(p, "aux:cnd"):
            mood = "Cnd"
        mood = mood or ("Ind" if tense else None)
        voice = "Pass" if T.children(p, "aux:pass") or T.f(p, "Voice") == "Pass" else None
        neg = any(part[c] == "przeczenie" for c in T.kids[p]) or any(
            part[c] == "przeczenie" for w in words for c in T.kids[w]
        )
        args = []
        for c in T.kids[p]:
            if part[c] not in ARG_PARTS:
                continue
            for a in [c, *_conjuncts(T, c)]:
                if part[a] not in ARG_PARTS:
                    continue
                span = [x for x in T.subtree(a, stop=frozenset(pset - {a})) if part[x] != "interpunkcja"]
                args.append({"q": q[a], "part": part[a], "okol": okol[a], "i": a, "span": [min(span), max(span)]})
        frames.append(
            {
                "pred": p,
                "words": words,
                "kind": kind,
                "aspect": aspect,
                "tense": tense,
                "mood": mood,
                "voice": voice,
                "neg": bool(neg),
                "clause": clause_of[p],
                "args": sorted(args, key=lambda a: a["i"]),
            }
        )

    out_toks = []
    for i in range(1, n + 1):
        x = T.tok(i)
        out_toks.append(
            {
                "i": i,
                "form": x.get("form"),
                "lemma": x.get("lemma"),
                "upos": x.get("upos"),
                "pos": POS_PL.get(x.get("upos") or "X", "inne"),
                "feats": {k: v for k, v in (x.get("feats") or {}).items() if k in FEAT_PL},
                "cechy": feats_pl(x.get("feats") or {}),
                "head": T.head(i),
                "deprel": T.rel(i),
                "part": part[i],
                "q": q[i],
                "okol": okol[i],
                "of": of[i],
                "clause": clause_of[i],
            }
        )
    return {"tokens": out_toks, "clauses": clauses, "frames": frames}


def _depth(T: Tree, i: int) -> int:
    d, seen = 0, set()
    while i and i not in seen:
        seen.add(i)
        i = T.head(i)
        d += 1
    return d


def _clause_of(T: Tree, i: int, ids: dict[int, int]) -> int | None:
    seen = set()
    while i and i not in seen:
        if i in ids:
            return ids[i]
        seen.add(i)
        i = T.head(i)
    return ids.get(next(iter(ids), 0)) if ids else None


def _conjuncts(T: Tree, i: int) -> list[int]:
    out, st = [], [c for c in T.children(i, "conj")]
    while st:
        c = st.pop()
        if c in out:
            continue
        out.append(c)
        st.extend(T.children(c, "conj"))
    return out


def triples(a: dict[str, Any]) -> set[tuple]:
    """Role do role-F1: (orzeczenie, pytanie, głowa argumentu) + przeczenie (orzeczenie, 'NIE', 0)."""
    out = set()
    for f in a["frames"]:
        for g in f["args"]:
            out.add((f["pred"], g["q"], g["i"]))
        if f["neg"]:
            out.add((f["pred"], "NIE", 0))
    return out
