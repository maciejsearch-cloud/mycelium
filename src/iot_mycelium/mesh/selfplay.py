"""Samodzielne ćwiczenia ze sprawdzalną odpowiedzią (etap S2): polska logika i język, generator + sprawdzarka.

Kategorie (każda z odpowiedzią wyliczaną programem, bez człowieka i bez nauczyciela):
  warunki (jeśli… to…: modus ponens/tollens, błędy afirmacji następnika/negacji poprzednika), sylogizmy,
  negacja, kwantyfikatory (każdy/niektóry/żaden), zgodność przypadka/rodzaju/liczby (kto komu co zrobił – z odmiany),
  sprzeczność, zadania tekstowe z arytmetyką, porządek; (25.10) analogie z jawnej relacji, ciągi, kolejność w czasie,
  przyczyna→skutek, łańcuchy 2–3 kroków, „nie wszystkie = niektóre nie”, liczebniki z odmianą, aspekt czasownika.
Każde zadanie ma poziom 1–3 (więcej kroków, zmyłki, przestawiony szyk); `target_levels` wybiera poziom, na którym
model ma 30–70% (tam uczy się najszybciej). Rozstrzygnięcia tak/nie/nie wiadomo są losowane po równo w każdej kategorii,
a `Tally` podaje obok trafności wynik „zawsze ta sama odpowiedź” (najczęstsza poprawna odpowiedź w kategorii).
`human_items` tworzy pytania, których program NIE rozstrzygnie (analogie na wyczucie, zdrowy rozsądek, parafrazy,
naturalność zdań) – odpowiedź ustalają ludzie (Ucz AI → Weryfikuj), program niczego tu nie „zgaduje”.
Do danych treningowych trafia tylko odpowiedź modelu uznana przez `check` za poprawną. Żadnego wykonywania kodu z modelu.
Brak przecieku: dedup sha256 znormalizowanego pytania, odrzucenie pytań, których hash jest w zbiorze bramki albo które
dzielą z nim n-gram słów (domyślnie 8). Zbiór bramki nigdy nie jest tu zmieniany. `Tally` liczy trafność per kategoria.
"""

from __future__ import annotations

import hashlib
import random
import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field

# imię: (mianownik, dopełniacz, celownik, biernik, rodzaj)
PEOPLE = {
    "Ala": ("Ala", "Ali", "Ali", "Alę", "ż"),
    "Ewa": ("Ewa", "Ewy", "Ewie", "Ewę", "ż"),
    "Iza": ("Iza", "Izy", "Izie", "Izę", "ż"),
    "Basia": ("Basia", "Basi", "Basi", "Basię", "ż"),
    "Marta": ("Marta", "Marty", "Marcie", "Martę", "ż"),
    "Adam": ("Adam", "Adama", "Adamowi", "Adama", "m"),
    "Bartek": ("Bartek", "Bartka", "Bartkowi", "Bartka", "m"),
    "Darek": ("Darek", "Darka", "Darkowi", "Darka", "m"),
    "Filip": ("Filip", "Filipa", "Filipowi", "Filipa", "m"),
    "Janek": ("Janek", "Janka", "Jankowi", "Janka", "m"),
}
NAMES = list(PEOPLE)
CATS = [("wróble", "ptaki"), ("róże", "rośliny"), ("dęby", "drzewa"), ("karpie", "ryby"), ("koty", "ssaki"),
        ("pszczoły", "owady"), ("tulipany", "kwiaty"), ("jamniki", "psy")]  # fmt: skip
GEN_PL = {"ptaki": "ptaków", "rośliny": "roślin", "drzewa": "drzew", "ryby": "ryb", "ssaki": "ssaków", "owady": "owadów",
          "kwiaty": "kwiatów", "psy": "psów"}  # fmt: skip
EVENTS = [("pada deszcz", "nie pada deszcz", "ulica jest mokra", "ulica nie jest mokra"),
          ("jest niedziela", "nie jest niedziela", "sklep jest zamknięty", "sklep nie jest zamknięty"),
          ("Ala ma gorączkę", "Ala nie ma gorączki", "Ala zostaje w domu", "Ala nie zostaje w domu"),
          ("świeci słońce", "nie świeci słońce", "Janek idzie na spacer", "Janek nie idzie na spacer")]  # fmt: skip
CATEGORIES = (
    "warunki",
    "sylogizm",
    "negacja",
    "kwantyfikatory",
    "odmiana",
    "sprzeczność",
    "zadanie tekstowe",
    "porządek",
    "analogia",
    "ciąg",
    "kolejność w czasie",
    "przyczyna",
    "łańcuch",
    "nie wszystkie",
    "liczebniki",
    "aspekt",
)
# kategorie z rozstrzygnięciem tak/nie/nie wiadomo → możliwe odpowiedzi (losowane po równo)
TERNARY = {
    "warunki": ("tak", "nie", "nie wiadomo"),
    "sylogizm": ("tak", "nie", "nie wiadomo"),
    "negacja": ("tak", "nie"),
    "kwantyfikatory": ("tak", "nie", "nie wiadomo"),
    "sprzeczność": ("tak", "nie"),
    "przyczyna": ("tak", "nie", "nie wiadomo"),
    "łańcuch": ("tak", "nie", "nie wiadomo"),
    "nie wszystkie": ("tak", "nie", "nie wiadomo"),
    "aspekt": ("tak", "nie", "nie wiadomo"),
}
LEVELS = (1, 2, 3)
YN = " Odpowiedz: tak, nie albo nie wiadomo."


@dataclass(frozen=True)
class Task:
    kind: str
    question: str
    answer: str
    level: int = 1
    options: tuple[str, ...] = ()  # odpowiedzi do wyboru (gdy nie tak/nie/nie wiadomo) – dla ludzi i sprawdzarki

    @property
    def sha(self) -> str:
        return qhash(self.question)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).lower().strip()
    return re.sub(r"[\s.,!?;:„”\"'()]+", " ", s).strip()


def qhash(q: str) -> str:
    return hashlib.sha256(norm(q).encode()).hexdigest()


def ngrams(text: str, n: int = 8) -> set[tuple[str, ...]]:
    w = norm(text).split()
    return {tuple(w[i : i + n]) for i in range(len(w) - n + 1)}


# ---------------------------------------------------------------- generatory
def conditional(r: random.Random, level: int = 1) -> Task:
    p, np_, q, nq = r.choice(EVENTS)
    form = r.randrange(4)
    if form == 0:  # modus ponens
        return Task("warunki", f"Jeśli {p}, to {q}. Wiadomo, że {p}. Czy {q}?{YN}", "tak")
    if form == 1:  # modus tollens
        return Task("warunki", f"Jeśli {p}, to {q}. Wiadomo, że {nq}. Czy {p}?{YN}", "nie")
    if form == 2:  # afirmacja następnika – błąd
        return Task("warunki", f"Jeśli {p}, to {q}. Wiadomo, że {q}. Czy {p}?{YN}", "nie wiadomo")
    return Task("warunki", f"Jeśli {p}, to {q}. Wiadomo, że {np_}. Czy {nq}?{YN}", "nie wiadomo")


def syllogism(r: random.Random, level: int = 1) -> Task:
    (x, y), name = r.choice(CATS), r.choice(NAMES)
    form = r.randrange(3)
    if form == 0:
        return Task("sylogizm", f"Wszystkie {x} to {y}. {name} hoduje {x}. Czy {name} hoduje {y}?{YN}", "tak")
    if form == 1:
        return Task("sylogizm", f"Wszystkie {x} to {y}. {name} hoduje {y}. Czy {name} hoduje {x}?{YN}", "nie wiadomo")
    return Task(
        "sylogizm", f"Wszystkie {x} to {y}. {name} nie hoduje żadnych {GEN_PL[y]}. Czy {name} hoduje {x}?{YN}", "nie"
    )


def negation(r: random.Random, level: int = 1) -> Task:
    _, np_, q, nq = r.choice(EVENTS)
    k = r.choice({1: (1, 2), 2: (2, 3), 3: (3, 4)}[level])
    stmt = q
    for _ in range(k):
        stmt = f"nieprawda, że {stmt}"
    truth = k % 2 == 0  # parzysta liczba zaprzeczeń = zdanie prawdziwe
    return Task("negacja", f"Wiadomo, że {stmt}. Czy {q}?{YN}", "tak" if truth else "nie", level)


def quantifier(r: random.Random, level: int = 1) -> Task:
    (x, y) = r.choice(CATS)
    form = r.randrange(4)
    if form == 0:
        return Task("kwantyfikatory", f"Żadne {x} nie są zielone. Czy któreś {x} są zielone?{YN}", "nie")
    if form == 1:
        return Task("kwantyfikatory", f"Wszystkie {x} są małe (każdy osobnik). Czy jakieś {x} są duże?{YN}", "nie")
    if form == 2:
        return Task("kwantyfikatory", f"Niektóre {x} są głośne. Czy wszystkie {x} są głośne?{YN}", "nie wiadomo")
    return Task("kwantyfikatory", f"Niektóre {x} są głośne. Czy jakieś {x} są głośne?{YN}", "tak")


def agreement(r: random.Random, level: int = 1) -> Task:
    """Kto komu co dał – szyk zdania przestawiony, rolę zdradza tylko przypadek (poziom ≥ 2: zawsze szyk przestawiony)."""
    a, b = r.sample(NAMES, 2)
    pa, pb = PEOPLE[a], PEOPLE[b]
    verb = "dała" if pa[4] == "ż" else "dał"
    thing = r.choice(["książkę", "jabłko", "list", "kwiaty"])
    order = r.randrange(3) if level == 1 else r.choice((1, 2))
    s = [f"{pa[0]} {verb} {pb[2]} {thing}", f"{pb[2]} {verb} {pa[0]} {thing}", f"{thing} {pb[2]} {verb} {pa[0]}"][order]
    s = s[0].upper() + s[1:]
    if r.random() < 0.5:
        return Task("odmiana", f"{s}. Kto dał? Podaj imię.", a, level)
    return Task("odmiana", f"{s}. Komu dano? Podaj imię w mianowniku.", b, level)


def contradiction(r: random.Random, level: int = 1) -> Task:
    _, np_, q, nq = r.choice(EVENTS)
    if r.random() < 0.5:
        return Task("sprzeczność", f"Czy zdania „{q}” oraz „{nq}” mogą być jednocześnie prawdziwe?{YN}", "nie")
    (x, y) = r.choice(CATS)
    return Task(
        "sprzeczność", f"Czy zdania „niektóre {x} są duże” oraz „niektóre {x} nie są duże” mogą być jednocześnie prawdziwe?{YN}",
        "tak",
    )  # fmt: skip


def word_problem(r: random.Random, level: int = 1) -> Task:
    a, b = r.sample(NAMES, 2)
    pa = PEOPLE[a]
    x, y = r.randint(3, 60), r.randint(2, 40)
    if level >= 2:
        v = "miała" if pa[4] == "ż" else "miał"
        d = "dostała" if pa[4] == "ż" else "dostał"
        g = "oddała" if pa[4] == "ż" else "oddał"
        z = r.randint(1, x + y - 1)
        q = f"{a} {v} {x} jabłek, {d} {y} od {PEOPLE[b][1]} i {g} {z} {PEOPLE[b][2]}."
        tot = x + y - z
        if level == 3:
            k = r.randint(2, 4)
            q += f" Potem liczba jabłek {PEOPLE[a][1]} zwiększyła się {k}-krotnie."
            tot *= k
        return Task("zadanie tekstowe", f"{q} Ile jabłek ma teraz {a}?", str(tot), level)
    form = r.randrange(3)
    if form == 0:
        v = "miała" if pa[4] == "ż" else "miał"
        d = "dostała" if pa[4] == "ż" else "dostał"
        return Task(
            "zadanie tekstowe",
            f"{a} {v} {x} jabłek i {d} jeszcze {y} od {PEOPLE[b][1]}. Ile jabłek ma teraz {a}?",
            str(x + y),
        )
    if form == 1:
        x = max(x, y + 1)
        v = "miała" if pa[4] == "ż" else "miał"
        g = "oddała" if pa[4] == "ż" else "oddał"
        return Task(
            "zadanie tekstowe",
            f"{a} {v} {x} zł i {g} {y} zł {PEOPLE[b][2]}. Ile złotych zostało {PEOPLE[a][2]}?",
            str(x - y),
        )
    k = r.randint(2, 9)
    return Task("zadanie tekstowe", f"W {k} pudełkach jest po {y} kredek. Ile kredek jest razem?", str(k * y))  # fmt: skip


def ordering(r: random.Random, level: int = 1) -> Task:
    k = 2 + level
    n = r.sample(NAMES, k)
    h = r.sample(range(150, 200), k)
    who = sorted(zip(h, n, strict=True))
    hi = r.random() < 0.5
    parts = [f"{n[0]} ma {h[0]} cm wzrostu"] + [f"{n[i]} ma {h[i]} cm" for i in range(1, k - 1)]
    q = f"{', '.join(parts)}, a {n[-1]} ma {h[-1]} cm. Kto jest {'najwyższy' if hi else 'najniższy'}? Podaj imię."
    return Task("porządek", q, who[-1][1] if hi else who[0][1], level)


# --- nowe kategorie (25.10) -------------------------------------------------------------------------------------------
# analogia z JAWNEJ relacji (sprawdzalna): para przykładowa i pytanie mają tę samą relację z tabeli
REL = {
    "dom": [("ptak", "gniazdo"), ("pszczoła", "ul"), ("pies", "buda"), ("lis", "nora"), ("koń", "stajnia"), ("krowa", "obora")],
    "młode": [("krowa", "cielę"), ("koń", "źrebię"), ("kura", "kurczę"), ("owca", "jagnię"), ("pies", "szczenię"), ("kot", "kocię")],
    "przeciwieństwo": [("dzień", "noc"), ("ciepło", "zimno"), ("góra", "dół"), ("początek", "koniec"), ("prawda", "fałsz"),
                       ("wejście", "wyjście")],
    "narzędzie": [("malarz", "pędzel"), ("krawiec", "igła"), ("drwal", "siekiera"), ("pisarz", "pióro"), ("rybak", "wędka"),
                  ("fryzjer", "nożyczki")],
}  # fmt: skip


def analogy(r: random.Random, level: int = 1) -> Task:
    rel = r.choice(sorted(REL))
    (a, b), (c, d) = r.sample(REL[rel], 2)
    # zmyłki: poziom 1 – z innych relacji; poziom ≥ 2 – także druga strona tej samej relacji (np. „pszczoła” zamiast „ul”)
    others = [y for k, v in REL.items() if k != rel for _, y in v]
    dist = r.sample(others, 3)
    if level >= 2:
        dist[0] = c if c != d else dist[0]
    if level == 3:
        dist[1] = r.choice([y for x, y in REL[rel] if y != d and x != c])
    opts = tuple(sorted({d, *dist}))
    q = f"{a} : {b} = {c} : ? Wybierz jedno słowo: {', '.join(opts)}."
    return Task("analogia", q, d, level, opts)


def sequence(r: random.Random, level: int = 1) -> Task:
    if level == 1:
        a, d = r.randint(1, 20), r.randint(2, 9)
        xs = [a + i * d for i in range(5)]
    elif level == 2:
        a, q = r.randint(1, 5), r.choice((2, 3))
        xs = [a * q**i for i in range(5)]
    else:  # różnice rosną o stałą
        a, d, e = r.randint(1, 10), r.randint(1, 5), r.randint(1, 3)
        xs = [a]
        for i in range(4):
            xs.append(xs[-1] + d + i * e)
    q = f"Jaka liczba jest następna w ciągu: {', '.join(map(str, xs[:4]))}, ? Podaj liczbę."
    return Task("ciąg", q, str(xs[4]), level)


def temporal(r: random.Random, level: int = 1) -> Task:
    k = 2 + level
    order = r.sample(NAMES, k)  # kolejność przyjścia
    facts = [f"{order[i]} przyszedł wcześniej niż {order[i + 1]}" for i in range(k - 1)]
    facts = [f.replace(" przyszedł ", " przyszła ") if PEOPLE[f.split()[0]][4] == "ż" else f for f in facts]
    if level >= 2:
        r.shuffle(facts)  # zmyłka: fakty nie po kolei
    last = r.random() < 0.5
    q = f"{'. '.join(facts)}. Kto przyszedł {'ostatni' if last else 'pierwszy'}? Podaj imię."
    return Task("kolejność w czasie", q, order[-1] if last else order[0], level)


CAUSES = [("zgasło światło", "w pokoju zrobiło się ciemno"), ("spadł śnieg", "dzieci ulepiły bałwana"),
          ("Ala zaspała", "Ala spóźniła się do szkoły"), ("zepsuł się autobus", "Janek poszedł pieszo"),
          ("piec przestał działać", "w domu zrobiło się zimno"), ("rzeka wylała", "droga została zamknięta")]  # fmt: skip


def causal(r: random.Random, level: int = 1) -> Task:
    (c1, e1), (c2, e2) = r.sample(CAUSES, 2)
    form = r.randrange(3)
    if form == 0:  # łańcuch przyczyn – skutek wynika
        return Task("przyczyna", f"Ponieważ {c1}, {e1}. Wiadomo, że {c1}. Czy {e1}?{YN}", "tak", level)
    if form == 1:  # skutek bez przyczyny – nie wiadomo (mogła być inna)
        return Task("przyczyna", f"Jeśli {c1}, to {e1}. Wiadomo, że {e1}. Czy na pewno {c1}?{YN}", "nie wiadomo", level)
    return Task(
        "przyczyna",
        f"Zawsze gdy {c1}, to {e1}. Tym razem okazało się, że nieprawda, że {e1}. Czy {c1}?{YN}",
        "nie",
        level,
    )


def chain(r: random.Random, level: int = 1) -> Task:
    """2–3 kroki: jeśli A to B, jeśli B to C (, jeśli C to D)."""
    steps = 2 if level < 3 else 3
    props = [f"lampka {k} świeci" for k in r.sample("ABCDEFGH", steps + 1)]
    negs = [p.replace(" świeci", " nie świeci") for p in props]
    rules = [f"Jeśli {props[i]}, to {props[i + 1]}" for i in range(steps)]
    if level >= 2:
        r.shuffle(rules)
    form = r.randrange(3)
    if form == 0:
        return Task("łańcuch", f"{'. '.join(rules)}. Wiadomo, że {props[0]}. Czy {props[-1]}?{YN}", "tak", level)
    if form == 1:
        return Task("łańcuch", f"{'. '.join(rules)}. Wiadomo, że {negs[-1]}. Czy {props[0]}?{YN}", "nie", level)
    return Task("łańcuch", f"{'. '.join(rules)}. Wiadomo, że {props[-1]}. Czy {props[0]}?{YN}", "nie wiadomo", level)


def not_all(r: random.Random, level: int = 1) -> Task:
    (x, _) = r.choice(CATS)
    form = r.randrange(3)
    if form == 0:
        return Task("nie wszystkie", f"Nie wszystkie {x} są głośne. Czy niektóre {x} nie są głośne?{YN}", "tak", level)
    if form == 1:
        return Task("nie wszystkie", f"Nie wszystkie {x} są głośne. Czy wszystkie {x} są głośne?{YN}", "nie", level)
    return Task("nie wszystkie", f"Nie wszystkie {x} są głośne. Czy żadne {x} nie są głośne?{YN}", "nie wiadomo", level)


# liczebnik → forma rzeczownika (2–4: mianownik lm., 5+: dopełniacz lm.; 12–14 jak 5+, 22–24 jak 2–4)
NOUNS = {"kot": ("koty", "kotów"), "książka": ("książki", "książek"), "jabłko": ("jabłka", "jabłek"), "dom": ("domy", "domów"),
         "krzesło": ("krzesła", "krzeseł"), "ryba": ("ryby", "ryb")}  # fmt: skip


def numeral_form(n: int, noun: str) -> str:
    few, many = NOUNS[noun]
    if n == 1:
        return noun
    return few if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else many


def numerals(r: random.Random, level: int = 1) -> Task:
    noun = r.choice(sorted(NOUNS))
    pool = {1: [2, 3, 4, 5, 6, 7, 8, 9], 2: [10, 11, 12, 13, 14, 15, 20, 21], 3: [22, 23, 24, 25, 32, 104, 112, 1000]}[
        level
    ]
    n = r.choice(pool)
    ans = numeral_form(n, noun)
    opts = tuple(sorted({noun, *NOUNS[noun]}))
    return Task("liczebniki", f"Uzupełnij: {n} … ({noun}). Wybierz jedną formę: {', '.join(opts)}.", ans, level, opts)


# czasownik: (niedokonany przeszły m/ż, dokonany przeszły m/ż, dopełnienie)
VERBS = [("pisał", "pisała", "napisał", "napisała", "list"), ("czytał", "czytała", "przeczytał", "przeczytała", "książkę"),
         ("malował", "malowała", "pomalował", "pomalowała", "płot"), ("jadł", "jadła", "zjadł", "zjadła", "obiad")]  # fmt: skip


def aspect(r: random.Random, level: int = 1) -> Task:
    name = r.choice(NAMES)
    f = PEOPLE[name][4] == "ż"
    ipf_m, ipf_f, pf_m, pf_f, obj = r.choice(VERBS)
    ipf, pf = (ipf_f, pf_f) if f else (ipf_m, pf_m)
    form = r.randrange(3)
    if form == 0:  # dokonany – czynność skończona
        return Task(
            "aspekt", f"{name} {pf} {obj}. Czy {name} skończył{'a' if f else ''} tę czynność?{YN}", "tak", level
        )
    if form == 1:  # niedokonany – nie wiadomo, czy skończył
        return Task(
            "aspekt",
            f"{name} {ipf} {obj}. Czy {name} skończył{'a' if f else ''} tę czynność?{YN}",
            "nie wiadomo",
            level,
        )
    return Task(
        "aspekt", f"{name} {ipf} {obj}, ale przerwał{'a' if f else ''} w połowie. Czy {name} {pf} {obj}?{YN}", "nie", level
    )  # fmt: skip


GENERATORS = {
    "warunki": conditional,
    "sylogizm": syllogism,
    "negacja": negation,
    "kwantyfikatory": quantifier,
    "odmiana": agreement,
    "sprzeczność": contradiction,
    "zadanie tekstowe": word_problem,
    "porządek": ordering,
    "analogia": analogy,
    "ciąg": sequence,
    "kolejność w czasie": temporal,
    "przyczyna": causal,
    "łańcuch": chain,
    "nie wszystkie": not_all,
    "liczebniki": numerals,
    "aspekt": aspect,
}


# najwyższy poziom, który naprawdę zmienia zadanie (reszta kategorii ma jeden poziom)
MAX_LEVEL = {"negacja": 3, "odmiana": 2, "zadanie tekstowe": 3, "porządek": 3, "analogia": 3, "ciąg": 3,
             "kolejność w czasie": 3, "łańcuch": 3, "liczebniki": 3}  # fmt: skip


def make(kind: str, r: random.Random, level: int = 1) -> Task:
    lv = max(1, min(level, MAX_LEVEL.get(kind, 1)))
    t = GENERATORS[kind](r, lv)
    return t if t.level == lv else Task(t.kind, t.question, t.answer, lv, t.options)


def generate(
    n: int,
    seed: int,
    exclude: Iterable[str] = (),
    gate_ngrams: set[tuple[str, ...]] | None = None,
    k: int = 8,
    levels: dict[str, int] | None = None,
    weights: dict[str, float] | None = None,
    kinds: Iterable[str] | None = None,
) -> list[Task]:
    """n unikalnych zadań; pomija hashe z `exclude` i pytania dzielące n-gram (k słów) ze zbiorem bramki.
    Rozstrzygnięcia tak/nie/nie wiadomo po równo w każdej kategorii (cel losowany w kółko, potem losowanie zadania
    z tym celem); `levels` = poziom na kategorię (domyślnie 1), `weights` = względna liczba zadań kategorii."""
    r, seen, out = random.Random(seed), set(exclude), []
    ks = list(kinds or CATEGORIES)
    w = [max(0.0, (weights or {}).get(c, 1.0)) for c in ks]
    turn: dict[str, int] = {}
    tries = 0
    while len(out) < n and tries < n * 80:
        tries += 1
        kind = r.choices(ks, weights=w)[0]
        want = None
        if kind in TERNARY:
            want = TERNARY[kind][turn.get(kind, 0) % len(TERNARY[kind])]
        t = None
        for _ in range(40):
            c = make(kind, r, (levels or {}).get(kind, 1))
            if want is None or c.answer == want:
                t = c
                break
        if t is None or t.sha in seen or (gate_ngrams and ngrams(t.question, k) & gate_ngrams):
            continue
        turn[kind] = turn.get(kind, 0) + 1
        seen.add(t.sha)
        out.append(t)
    return out


def target_levels(per_level: dict[str, dict[str, dict]], lo: float = 0.3, hi: float = 0.7, min_n: int = 8) -> dict:
    """Program nauczania: dla każdej kategorii poziom, na którym poprzedni pomiar dał trafność w [lo, hi].
    Brak pomiaru → poziom 1. Powyżej `hi` → poziom wyżej (do MAX_LEVEL), poniżej `lo` → poziom niżej (min. 1).
    Zwraca {"levels": {kat: poziom}, "weights": {kat: waga}} – kategorie w strefie 30–70% dostają wagę 2."""
    levels, weights = {}, {}
    for kind in CATEGORIES:
        rows = {int(lv): v for lv, v in (per_level.get(kind) or {}).items() if v.get("n", 0) >= min_n}
        top = MAX_LEVEL.get(kind, 1)
        if not rows:
            levels[kind], weights[kind] = 1, 1.0
            continue
        lv = max(rows)  # ostatnio najtrudniejszy mierzony poziom
        acc = rows[lv]["acc"]
        if acc > hi and lv < top:
            lv += 1
        elif acc < lo and lv > 1:
            lv -= 1
        levels[kind] = lv
        a = rows.get(lv, {}).get("acc")
        weights[kind] = 2.0 if a is not None and lo <= a <= hi else 1.0
    return {"levels": levels, "weights": weights}


def check(task: Task, reply: str) -> bool:
    """Ścisła sprawdzarka: liczba = ostatnia liczba odpowiedzi; rozstrzygnięcie i imię – dokładnie jedno w odpowiedzi
    (powtórzenie opcji „tak, nie albo nie wiadomo” albo kilku imion = źle)."""
    s = norm(reply)
    if re.fullmatch(r"-?\d+", task.answer):
        nums = re.findall(r"-?\d+", s)
        return bool(nums) and nums[-1] == task.answer
    if task.answer in ("tak", "nie", "nie wiadomo"):
        s2 = re.sub(r"nie wiadomo|nie da się (?:stwierdzić|ustalić|tego stwierdzić)", " NW ", s)
        got = {"nie wiadomo" if v == "NW" else v for v in re.findall(r"\b(NW|tak|nie)\b", s2)}
        return got == {task.answer}
    if task.options:  # wybór jednego słowa z listy: dokładnie jedno słowo z listy w odpowiedzi
        opts = {norm(o): o for o in task.options}
        found = {opts[w] for w in re.findall(r"\w+", s) if w in opts}
        return found == {task.answer}
    forms = {f.lower(): name for name, p in PEOPLE.items() for f in p[:4]}
    names = {forms[w] for w in re.findall(r"\w+", s) if w in forms}
    return names == {task.answer}


@dataclass
class Tally:
    """Trafność per kategoria (do panelu): tylko prawdziwe próby modelu, brak prób = brak wpisu.
    Gdy podano poprawną odpowiedź (`answer`), summary ma też `baseline` = trafność strategii „zawsze ta sama
    odpowiedź” (najczęstsza poprawna odpowiedź w tej kategorii) – wynik modelu musi być od niej wyższy, żeby coś znaczył."""

    seen: dict[str, int] = field(default_factory=dict)
    ok: dict[str, int] = field(default_factory=dict)
    answers: dict[str, dict[str, int]] = field(default_factory=dict)
    levels: dict[str, dict[int, list[int]]] = field(default_factory=dict)

    def add(self, kind: str, correct: bool, answer: str | None = None, level: int | None = None) -> None:
        self.seen[kind] = self.seen.get(kind, 0) + 1
        self.ok[kind] = self.ok.get(kind, 0) + int(correct)
        if answer is not None:
            a = self.answers.setdefault(kind, {})
            a[answer] = a.get(answer, 0) + 1
        if level is not None:
            lv = self.levels.setdefault(kind, {}).setdefault(level, [0, 0])
            lv[0] += 1
            lv[1] += int(correct)

    def summary(self) -> dict[str, dict]:
        out = {}
        for k, n in sorted(self.seen.items()):
            row = {"n": n, "correct": self.ok[k], "acc": round(self.ok[k] / n, 4)}
            if k in self.answers:
                best, cnt = max(sorted(self.answers[k].items()), key=lambda x: x[1])
                row["baseline"] = round(cnt / n, 4)
                row["baseline_answer"] = best
            out[k] = row
        return out

    def per_level(self) -> dict[str, dict[str, dict]]:
        return {
            k: {str(lv): {"n": v[0], "correct": v[1], "acc": round(v[1] / v[0], 4)} for lv, v in sorted(d.items())}
            for k, d in sorted(self.levels.items())
        }


# --- pytania tylko dla ludzi: program ich NIE rozstrzyga ------------------------------------------------------------
@dataclass(frozen=True)
class HumanItem:
    kind: str  # analogia na wyczucie | zdrowy rozsądek | parafraza | naturalność
    question: str
    options: tuple[str, ...]  # pokazywane ludziom; zawsze z „nie wiadomo” albo równoważnym
    why: str  # dlaczego program tego nie rozstrzygnie

    @property
    def sha(self) -> str:
        return qhash(self.kind + "|" + self.question)


# a : b = c : ?  – kilka odpowiedzi „prawie dobrych”, żadna nie wynika z bazy relacji
FUZZY = [("noc", "ciemność", "cisza", ("spokój", "hałas", "sen", "szept")),
         ("morze", "woda", "pustynia", ("piasek", "upał", "wielbłąd", "pustka")),
         ("serce", "krew", "silnik", ("paliwo", "olej", "tłok", "prąd")),
         ("wiosna", "rok", "poranek", ("dzień", "świt", "budzik", "tydzień")),
         ("korzeń", "drzewo", "fundament", ("dom", "mur", "piwnica", "beton")),
         ("ogień", "dym", "gniew", ("krzyk", "łzy", "kłótnia", "cisza")),
         ("pióro", "pisarz", "głos", ("śpiewak", "mówca", "radio", "aktor")),
         ("ziarno", "chleb", "nuta", ("piosenka", "melodia", "koncert", "płyta"))]  # fmt: skip
SENSE = ["Czy otwarte zimą okno sprawi, że w pokoju zrobi się zimniej?", "Czy picie kawy wieczorem może utrudnić zaśnięcie?",
         "Czy parasol chroni przed deszczem lepiej niż kaptur?", "Czy roślina postawiona w ciemnej piwnicy urośnie tak samo jak na parapecie?",
         "Czy po deszczu łatwiej poślizgnąć się na chodniku?", "Czy zamrażarka zatrzyma psucie się mięsa na zawsze?",
         "Czy jazda rowerem pod górę męczy bardziej niż z górki?", "Czy kot wyczuje zapach jedzenia przez zamknięte pudełko?"]  # fmt: skip
SYN = [("hoduje", "ma w domu"), ("Wiadomo, że", "Wiemy, że"), ("Czy", "Czy można powiedzieć, że"), ("wszystkie", "prawie wszystkie"),
       ("Jeśli", "Gdy"), ("przyszedł wcześniej niż", "był szybciej niż")]  # fmt: skip
TN = ("tak", "nie", "nie wiadomo")


def human_items(n: int, seed: int, tasks: Iterable[Task] = ()) -> list[HumanItem]:
    """Pytania, których odpowiedź ustalają ludzie. Parafrazy powstają przez podmianę wyrażeń z `SYN` – część zmienia
    sens (np. „wszystkie” → „prawie wszystkie”), ale program nie zakłada, która: decyzja należy do ludzi."""
    r = random.Random(seed)
    tasks = list(tasks) or generate(40, seed)
    out: dict[str, HumanItem] = {}
    gens = ("fuzzy", "sense", "para", "nat")
    tries = 0
    while len(out) < n and tries < n * 20:
        tries += 1
        g = gens[tries % len(gens)]
        if g == "fuzzy":
            a, b2, c, opts = r.choice(FUZZY)
            it = HumanItem("analogia na wyczucie", f"„{a}” ma się do „{b2}” tak jak „{c}” do…?", (*opts, "nic nie pasuje"),
                           "relacja nie jest zapisana w żadnej bazie – liczy się ludzkie wyczucie")  # fmt: skip
        elif g == "sense":
            it = HumanItem(
                "zdrowy rozsądek", r.choice(SENSE), TN, "wymaga wiedzy o świecie, nie wynika z treści zdania"
            )
        elif g == "para":
            t = r.choice(tasks)
            subs = [(a, b) for a, b in SYN if a in t.question]
            if not subs:
                continue
            a, b = r.choice(subs)
            q0 = t.question.replace(YN, "").strip()
            p = q0.replace(a, b, 1)
            it = HumanItem("parafraza", f"Czy te dwa pytania znaczą to samo?\n1) {q0}\n2) {p}", TN,
                           "program nie wie, czy podmiana słów zmieniła sens – to ocena człowieka")  # fmt: skip
        else:
            t = r.choice(tasks)
            it = HumanItem("naturalność", f"Czy to brzmi naturalnie po polsku?\n„{t.question.replace(YN, '').strip()}”", TN,
                           "zdanie złożył program z szablonu – tylko człowiek oceni, czy tak się mówi")  # fmt: skip
        out.setdefault(it.sha, it)
    return list(out.values())[:n]
