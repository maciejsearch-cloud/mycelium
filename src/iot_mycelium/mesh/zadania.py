"""Zadania wielokierunkowe do Ucz AI: matematyczne i analityczne, generowane programem i sprawdzane automatycznie.

* matematyczne – arytmetyka, ułamki, procenty, równania, zadania tekstowe, jednostki, proporcje, ułamki tekstowe, procent składany; poziomy 1–3; wynik liczony programem,
* analityczne – pytania o małe tabele z prawdziwych faktów Wikidata (CC0) z ``web/public/data/seed/facts.json``
  (liczba atomowa, data urodzenia, kontynent); odpowiedź wynika wyłącznie z pokazanej tabeli i jest liczona programem.

Każde zadanie ma 4 odpowiedzi do wyboru (a–d), dokładnie jedna poprawna. Poprawna odpowiedź trafia tylko do
``myc_gold`` (``scripts/gold_rotate.py``, pula z tajnego ``MYC_GOLD_SEED``), nigdy do przeglądarki. Zadania wzrokowe (Fashion-MNIST) buduje
``scripts/zadania_run.py``, bo potrzebują surowych obrazów.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from fractions import Fraction

from .selfplay import NOUNS, PEOPLE, ngrams, numeral_form, qhash

LETTERS = "abcd"
MATH = (
    "arytmetyka",
    "ułamki",
    "procenty",
    "równania",
    "zadanie tekstowe",
    "jednostki",
    "proporcje",
    "ułamki tekstowe",
    "procent składany",
)
ANALYTIC = ("tabela: pierwiastki", "tabela: daty urodzenia", "tabela: kontynenty")
MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września",
          "października", "listopada", "grudnia"]  # fmt: skip


@dataclass(frozen=True)
class Item:
    type: str  # matematyczne | analityczne
    kind: str
    q: str
    options: tuple[str, ...]
    answer: int  # indeks poprawnej odpowiedzi w options
    level: int = 1
    sources: tuple[str, ...] = field(default=())

    @property
    def sha(self) -> str:
        return qhash(self.q + " | " + " | ".join(self.options))

    @property
    def code(self) -> str:
        return LETTERS[self.answer]


def fmt(x: Fraction | int | float) -> str:
    """Liczba po polsku: całkowita bez ułamka, ułamek zwykły „p/q”, dziesiętna z przecinkiem."""
    if isinstance(x, Fraction):
        return str(x.numerator) if x.denominator == 1 else f"{x.numerator}/{x.denominator}"
    if isinstance(x, float):
        s = f"{x:.2f}".rstrip("0").rstrip(".")
        return s.replace(".", ",")
    return str(x)


def choices(r: random.Random, right, wrong: list) -> tuple[tuple[str, ...], int]:
    """4 różne odpowiedzi (sformatowane), jedna poprawna, kolejność losowa."""
    rs = fmt(right)
    out, seen = [rs], {rs}
    for w in wrong:
        s = fmt(w)
        if s not in seen and not s.startswith("-0"):
            out.append(s)
            seen.add(s)
        if len(out) == 4:
            break
    k = 1
    while len(out) < 4:  # awaryjnie: sąsiednie wartości
        for s in (fmt(right + k), fmt(right - k)):
            if s not in seen and len(out) < 4:
                out.append(s)
                seen.add(s)
        k += 1
    r.shuffle(out)
    return tuple(out), out.index(rs)


# ---------------------------------------------------------------- matematyczne


def arithmetic(r: random.Random, lv: int) -> Item:
    if lv == 1:
        a, b = r.randint(10, 99), r.randint(10, 99)
        op = r.choice("+-")
        if op == "-" and b > a:
            a, b = b, a
        v = a + b if op == "+" else a - b
        q = f"Ile to jest {a} {'+' if op == '+' else '−'} {b}?"
        wrong = [v + 10, v - 10, v + 1, v - 1, v + 2]
    elif lv == 2:
        if r.random() < 0.5:
            a, b = r.randint(12, 49), r.randint(3, 19)
            v, q = a * b, f"Ile to jest {a} × {b}?"
        else:
            b, v = r.randint(3, 19), r.randint(4, 40)
            a = b * v
            q = f"Ile to jest {a} : {b}?"
        wrong = [v + b, v - b, v + 10, v - 1, v + 1]
    else:
        a, b, c, d = r.randint(2, 30), r.randint(2, 12), r.randint(2, 12), r.randint(1, 40)
        v = a + b * c - d
        q = f"Ile to jest {a} + {b} × {c} − {d}? Pamiętaj o kolejności działań."
        wrong = [(a + b) * c - d, a + b * (c - d), v + 1, v - 2, v + c]
    o, i = choices(r, v, [w for w in wrong if w != v])
    return Item("matematyczne", "arytmetyka", q, o, i, lv)


def fractions(r: random.Random, lv: int) -> Item:
    if lv == 1:
        d = r.randint(3, 12)
        a, b = r.randint(1, d - 1), r.randint(1, d - 1)
        x, y = Fraction(a, d), Fraction(b, d)
        v = x + y
        q = f"Ile to jest {a}/{d} + {b}/{d}? Podaj wynik w najprostszej postaci."
        wrong = [Fraction(a + b, 2 * d), Fraction(a + b + 1, d), Fraction(abs(a - b) or 1, d), Fraction(a * b, d)]
    elif lv == 2:
        d1, d2 = r.sample([2, 3, 4, 5, 6, 8, 10], 2)
        a, b = r.randint(1, d1 - 1), r.randint(1, d2 - 1)
        v = Fraction(a, d1) + Fraction(b, d2)
        q = f"Ile to jest {a}/{d1} + {b}/{d2}? Podaj wynik w najprostszej postaci."
        wrong = [Fraction(a + b, d1 + d2), Fraction(a + b, d1 * d2), v + Fraction(1, d1 * d2), v - Fraction(1, d1 * d2)]
    else:
        a, b, c, d = r.randint(1, 9), r.randint(2, 9), r.randint(1, 9), r.randint(2, 9)
        if r.random() < 0.5:
            v, q = (
                Fraction(a, b) * Fraction(c, d),
                f"Ile to jest {a}/{b} × {c}/{d}? Podaj wynik w najprostszej postaci.",
            )
            wrong = [Fraction(a * d, b * c), Fraction(a + c, b + d), Fraction(a * c, b + d), v * 2]
        else:
            v, q = (
                Fraction(a, b) / Fraction(c, d),
                f"Ile to jest {a}/{b} : {c}/{d}? Podaj wynik w najprostszej postaci.",
            )
            wrong = [Fraction(a * c, b * d), Fraction(b * c, a * d), Fraction(a + d, b + c), v * 2]
    o, i = choices(r, v, [w for w in wrong if w != v and w > 0])
    return Item("matematyczne", "ułamki", q, o, i, lv)


def percents(r: random.Random, lv: int) -> Item:
    if lv == 1:
        p = r.choice([10, 20, 25, 50])
        n = r.choice(range(20, 400, 20))
        v = n * p // 100
        q = f"Ile to jest {p}% z {n}?"
        wrong = [v * 2, v // 2 or v + 3, n - v, v + 10]
    elif lv == 2:
        p = r.choice([5, 12, 15, 30, 35, 40, 60, 75])
        n = r.choice(range(40, 1000, 20))
        v = Fraction(n * p, 100)
        q = f"Ile to jest {p}% z {n}?"
        wrong = [v + 10, v * 2, Fraction(n, p) if p else v + 1, v - 5, Fraction(n * (100 - p), 100)]
    else:
        n = r.choice(range(100, 1001, 50))
        p1, p2 = r.choice([10, 20, 25, 50]), r.choice([10, 20, 25, 50])
        v = Fraction(n * (100 + p1) * (100 - p2), 10000)
        q = f"Cena {n} zł wzrosła o {p1}%, a potem nowa cena spadła o {p2}%. Ile złotych wynosi cena końcowa?"
        wrong = [Fraction(n * (100 + p1 - p2), 100), Fraction(n), v + 10, Fraction(n * (100 - p1) * (100 + p2), 10000)]
    o, i = choices(r, v, [w for w in wrong if w != v and w > 0])
    return Item("matematyczne", "procenty", q, o, i, lv)


def equations(r: random.Random, lv: int) -> Item:
    x = r.randint(-9 if lv == 3 else 1, 20)
    if lv == 1:
        a = r.randint(2, 40)
        q = f"Rozwiąż równanie: x + {a} = {x + a}. Ile wynosi x?"
        wrong = [x + a, x + 1, x - 1, x + 2 * a]
    elif lv == 2:
        a, b = r.randint(2, 9), r.randint(1, 30)
        q = f"Rozwiąż równanie: {a}x + {b} = {a * x + b}. Ile wynosi x?"
        wrong = [x + 1, x - 1, (a * x + b + b) // a, a * x, x + b]
    else:
        a, c = r.sample(range(2, 10), 2)
        b = r.randint(-20, 20)
        d = a * x + b - c * x
        sb = f"+ {b}" if b >= 0 else f"− {-b}"
        sd = f"+ {d}" if d >= 0 else f"− {-d}"
        q = f"Rozwiąż równanie: {a}x {sb} = {c}x {sd}. Ile wynosi x?"
        wrong = [-x, x + 1, x - 1, x + 2]
    o, i = choices(r, x, [w for w in wrong if w != x])
    return Item("matematyczne", "równania", q, o, i, lv)


def word(r: random.Random, lv: int) -> Item:
    a = r.choice(sorted(PEOPLE))
    pa = PEOPLE[a]
    f = pa[4] == "ż"
    noun = r.choice(sorted(NOUNS))
    if lv == 1:
        x, y = r.randint(3, 40), r.randint(2, 30)
        v = x + y
        q = (f"{a} {'miała' if f else 'miał'} {x} {numeral_form(x, noun)}, a potem {'dostała' if f else 'dostał'} "
             f"jeszcze {y}. Ile ma teraz?")  # fmt: skip
        wrong = [x - y if x > y else x * 2, v + 1, v - 1, x * y]
    elif lv == 2:
        k, c = r.randint(3, 12), r.randint(2, 25)
        v = k * c
        q = f"Jeden bilet kosztuje {c} zł. Ile złotych trzeba zapłacić za {k} {'bilety' if numeral_form(k, 'kot') == 'koty' else 'biletów'}?"
        wrong = [k + c, v + c, v - c, v + 10]
    else:
        s, t = r.choice([40, 50, 60, 80, 90, 100, 120]), r.choice([2, 3, 4, 5])
        h = r.choice([1, 2, 3])
        v = s * t - s * h
        q = (f"Pociąg jedzie ze stałą prędkością {s} km/h. Cała trasa zajmuje {t} h. Ile kilometrów zostało do celu "
             f"po {h} h jazdy?")  # fmt: skip
        wrong = [s * t, s * h, s * (t + h), v + s // 2]
    o, i = choices(r, v, [w for w in wrong if w != v and w > 0])
    return Item("matematyczne", "zadanie tekstowe", q, o, i, lv)


def units(r: random.Random, lv: int) -> Item:
    """Zamiana jednostek szkolnych (długość, masa, czas); odpowiedź w liczbie bez jednostki w treści pytania."""
    if lv == 1:
        # „Ile centymetrów ma A m B cm?” / metry ↔ km
        if r.random() < 0.5:
            m, cm = r.randint(1, 9), r.randint(1, 99)
            v = m * 100 + cm
            q = f"Ile centymetrów ma {m} m {cm} cm?"
            wrong = [m * 100 - cm, m + cm, v + 10, m * 10 + cm, v - 100]
        else:
            km = r.randint(1, 20)
            m = r.choice([0, 100, 250, 500, 750])
            v = km * 1000 + m
            q = f"Ile metrów ma {km} km" + (f" {m} m" if m else "") + "?"
            wrong = [km * 100 + m, v + 100, km * 1000 - m if m else v - 1000, v + 10]
    elif lv == 2:
        kind = r.choice(["czas", "masa", "pieniądze"])
        if kind == "czas":
            h, mi = r.randint(1, 5), r.choice([0, 15, 20, 30, 40, 45])
            v = h * 60 + mi
            q = f"Ile minut ma {h} h" + (f" {mi} min" if mi else "") + "?"
            wrong = [h * 100 + mi, v + 60, h * 60 - mi if mi else v - 60, v + 10]
        elif kind == "masa":
            kg, dag = r.randint(1, 8), r.randint(1, 99)
            v = kg * 100 + dag  # 1 kg = 100 dag
            q = f"Ile dekagramów ma {kg} kg {dag} dag?"
            wrong = [kg * 10 + dag, kg * 1000 + dag, v + 10, kg + dag]
        else:
            zl, gr = r.randint(1, 50), r.randint(1, 99)
            v = zl * 100 + gr
            q = f"Ile groszy ma {zl} zł {gr} gr?"
            wrong = [zl + gr, zl * 10 + gr, v + 10, zl * 100 - gr]
    else:
        # złożone: dni/godziny albo mm↔cm↔m
        if r.random() < 0.5:
            d, h = r.randint(1, 4), r.randint(1, 23)
            v = d * 24 + h
            q = f"Ile godzin ma {d} {'dni' if d != 1 else 'dzień'} {h} h?"
            wrong = [d * 24 - h, d * 10 + h, v + 24, d * 60 + h]
        else:
            m, cm, mm = r.randint(0, 3), r.randint(0, 9), r.randint(1, 9)
            if m == 0 and cm == 0:
                m = 1
            v = m * 1000 + cm * 10 + mm  # w mm
            parts = []
            if m:
                parts.append(f"{m} m")
            if cm:
                parts.append(f"{cm} cm")
            parts.append(f"{mm} mm")
            q = f"Ile milimetrów ma {' '.join(parts)}?"
            wrong = [m * 100 + cm * 10 + mm, v + 10, m * 1000 + cm + mm, v - mm]
    o, i = choices(r, v, [w for w in wrong if w != v and w > 0])
    return Item("matematyczne", "jednostki", q, o, i, lv)


def proportions(r: random.Random, lv: int) -> Item:
    """Proporcje i skalowanie (kl. 6–7): x w proporcji, przepisy, mapa."""
    if lv == 1:
        a, b = r.sample(range(2, 13), 2)
        k = r.randint(2, 8)
        v = b * k
        q = f"Wyznacz x z proporcji: {a} : {b} = {a * k} : x. Ile wynosi x?"
        wrong = [a * k, b * a, v + b, a + b * k, v - a]
    elif lv == 2:
        # przepis: na n osób / skalowanie
        n0, n1 = r.choice([2, 3, 4]), r.choice([6, 8, 9, 12])
        amt = r.randint(2, 20) * n0  # podzielne
        v = amt * n1 // n0
        q = f"Na {n0} osoby potrzeba {amt} dag mąki. Ile dekagramów mąki potrzeba na {n1} osób (ta sama proporcja)?"
        wrong = [amt + n1, amt * n0 // max(n1, 1), v + amt, n1 * amt, v - n0]
    else:
        # skala mapy 1:N → rzeczywista odległość
        scale = r.choice([25_000, 50_000, 100_000, 200_000])
        cm = r.choice([2, 3, 4, 5, 6, 8, 10])
        # 1 cm na mapie 1:N = N cm w terenie = N/100_000 km = N/100 m
        meters = cm * scale // 100  # N cm → /100 = m
        # podajemy odpowiedź w km jeśli ładnie wychodzi, inaczej w m
        if meters % 1000 == 0:
            v = meters // 1000
            q = f"Na mapie w skali 1:{scale} odcinek ma {cm} cm. Ile kilometrów ma ta odległość w terenie?"
            wrong = [cm * scale // 1000, v * 10, meters, v + 1, cm]
        else:
            v = meters
            q = f"Na mapie w skali 1:{scale} odcinek ma {cm} cm. Ile metrów ma ta odległość w terenie?"
            wrong = [cm * scale, v // 10 or v + 100, v + scale // 100, cm * 100, v - cm]
    o, i = choices(r, v, [w for w in wrong if w != v and w > 0])
    return Item("matematyczne", "proporcje", q, o, i, lv)


def fraction_word(r: random.Random, lv: int) -> Item:
    """Zadania tekstowe z ułamkami zwykłymi i dziesiętnymi (kl. 6–7); wynik liczony przez Fraction."""
    who = r.choice(sorted(PEOPLE))
    female = PEOPLE[who][4] == "ż"
    noun = r.choice(sorted(NOUNS))
    if lv == 1:
        den = r.choice([2, 3, 4, 5, 6, 8, 10])
        num = r.randint(1, den - 1)
        n = den * r.randint(2, 12)
        v = Fraction(n * num, den)
        q = (f"{who} {'miała' if female else 'miał'} {n} {numeral_form(n, noun)}. "
             f"Ile to jest {num}/{den} z tej liczby?")  # fmt: skip
        wrong = [n * num, n // den, n - int(v), Fraction(num, den) + n, v + 1, Fraction(num + n, den)]
    elif lv == 2:
        decs = [
            (Fraction(1, 4), "0,25"),
            (Fraction(1, 2), "0,5"),
            (Fraction(3, 4), "0,75"),
            (Fraction(1, 5), "0,2"),
            (Fraction(1, 10), "0,1"),
            (Fraction(2, 5), "0,4"),
        ]
        if r.random() < 0.5:
            frac, txt = r.choice(decs)
            n = frac.denominator * r.randint(2, 20)
            v = Fraction(n) * frac
            q = (f"{who} {'miała' if female else 'miał'} {n} {numeral_form(n, noun)}. "
                 f"Ile to jest {txt} z tej liczby?")  # fmt: skip
            wrong = [
                Fraction(n) + frac,
                Fraction(n * frac.numerator),
                n - int(v) if v.denominator == 1 else Fraction(n) - v,
                Fraction(n, 10),
                v * 2,
                Fraction(n) * (1 - frac),
            ]
        else:
            pairs = [
                (Fraction(5, 4), "1,25", Fraction(3, 4), "0,75"),
                (Fraction(3, 2), "1,5", Fraction(5, 2), "2,5"),
                (Fraction(7, 2), "3,5", Fraction(5, 2), "2,5"),
                (Fraction(1, 4), "0,25", Fraction(3, 4), "0,75"),
                (Fraction(1, 5), "0,2", Fraction(3, 5), "0,6"),
                (Fraction(5, 4), "1,25", Fraction(5, 4), "1,25"),
                (Fraction(1, 2), "0,5", Fraction(1, 4), "0,25"),
            ]
            x, xs, y, ys = r.choice(pairs)
            v = x + y
            q = (f"{who} {'kupiła' if female else 'kupił'} {xs} kg jabłek i {ys} kg gruszek. "
                 f"Ile kilogramów owoców {'kupiła' if female else 'kupił'} razem?")  # fmt: skip
            wrong = [
                abs(x - y) or x + 1,
                x * y,
                Fraction(x.numerator + y.numerator, x.denominator + y.denominator),
                v + 1,
                x,
                y,
            ]
    else:
        n = r.choice([12, 24, 36, 48, 60, 72, 80, 96, 120])
        pairs = [(1, 2), (1, 3), (1, 4), (2, 3), (1, 5), (3, 4), (2, 5), (1, 6), (3, 5)]
        if r.random() < 0.5:
            found = None
            for _ in range(40):
                (n1, d1), (n2, d2) = r.sample(pairs, 2)
                if n % d1 == 0 and (n * (d1 - n1) // d1) % d2 == 0:
                    found = (n1, d1, Fraction(n2, d2), f"{n2}/{d2}")
                    break
            if found is None:
                n, n1, d1, frac2, second = 24, 1, 3, Fraction(1, 4), "1/4"
            else:
                n1, d1, frac2, second = found
        else:
            decs = [
                (Fraction(1, 4), "0,25"),
                (Fraction(1, 2), "0,5"),
                (Fraction(1, 5), "0,2"),
                (Fraction(3, 4), "0,75"),
            ]
            found = None
            for _ in range(40):
                n1, d1 = r.choice(pairs)
                frac2, second = r.choice(decs)
                if n % d1 != 0:
                    continue
                rest = n * (d1 - n1) // d1
                if (rest * frac2.numerator) % frac2.denominator == 0:
                    found = (n1, d1, frac2, second)
                    break
            if found is None:
                n, n1, d1, frac2, second = 24, 1, 3, Fraction(1, 4), "0,25"
            else:
                n1, d1, frac2, second = found
        v = Fraction(n) * (1 - Fraction(n1, d1)) * (1 - frac2)
        q = (f"{who} {'miała' if female else 'miał'} {n} zł. Najpierw {'wydała' if female else 'wydał'} "
             f"{n1}/{d1} tej kwoty, a potem {second} reszty. Ile złotych zostało?")  # fmt: skip
        used1 = Fraction(n) * Fraction(n1, d1)
        rest1 = Fraction(n) - used1
        wrong = [
            Fraction(n) - used1 - Fraction(n) * frac2,
            rest1,
            used1 + rest1 * frac2,
            Fraction(n) * (1 - Fraction(n1, d1) - frac2),
            Fraction(n) * Fraction(n1, d1) * frac2,
        ]
    o, i = choices(r, v, [w for w in wrong if w != v and w > 0])
    return Item("matematyczne", "ułamki tekstowe", q, o, i, lv)


def compound_percent(r: random.Random, lv: int) -> Item:
    """Procent składany z kapitalizacją roczną (nie sekwencja +p% potem −q% z percents())."""
    who = r.choice(sorted(PEOPLE))
    female = PEOPLE[who][4] == "ż"
    wp = "wpłaciła" if female else "wpłacił"
    rates = (10, 20, 25, 50)
    if lv == 1:
        p = r.choice(rates)
        k = r.choice([200, 400, 500, 800, 1000, 1200, 1600, 2000])
        v = Fraction(k * (100 + p), 100)
        q = (f"{who} {wp} do banku {k} zł. Bank dolicza {p}% odsetek w skali roku. "
             f"Ile złotych będzie na koncie po 1 roku?")  # fmt: skip
        wrong = [
            Fraction(k * p, 100),
            Fraction(k),
            Fraction(k * (100 - p), 100),
            Fraction(k + p),
            Fraction(k * (100 + 2 * p), 100),
        ]
    elif lv == 2:
        p = r.choice(rates)
        pools = {
            10: [100, 200, 400, 500, 800, 1000, 2000],
            20: [125, 250, 500, 1000, 2000],
            25: [160, 320, 640, 800, 1600],
            50: [200, 400, 800, 1200, 1600],
        }
        k = r.choice(pools[p])
        ratio = Fraction(100 + p, 100)
        v = Fraction(k) * ratio * ratio
        q = (f"{who} {wp} do banku {k} zł na lokatę {p}% w skali roku. "
             f"Ile złotych będzie na koncie po 2 latach (procent składany, kapitalizacja roczna)?")  # fmt: skip
        wrong = [
            Fraction(k) * (1 + Fraction(2 * p, 100)),
            Fraction(k) * ratio,
            Fraction(k) * ratio**3,
            Fraction(k + 2 * p),
            Fraction(k) * Fraction(100 + p * p, 100),
        ]
    else:
        if r.random() < 0.5:
            p = r.choice(rates)
            pools = {
                10: [1000, 2000],
                20: [125, 250, 500, 1000],
                25: [64, 128, 256, 512, 640],
                50: [80, 160, 240, 400, 800],
            }
            k = r.choice(pools[p])
            ratio = Fraction(100 + p, 100)
            v = Fraction(k) * ratio**3
            q = (f"{who} {wp} do banku {k} zł na lokatę {p}% w skali roku. "
                 f"Ile złotych będzie na koncie po 3 latach (procent składany, kapitalizacja roczna)?")  # fmt: skip
            wrong = [
                Fraction(k) * (1 + Fraction(3 * p, 100)),
                Fraction(k) * ratio**2,
                Fraction(k) * ratio,
                Fraction(k + 3 * p),
            ]
        else:
            p1, p2 = r.sample(rates, 2)
            k = r.choice([200, 400, 500, 800, 1000, 1600, 2000])
            r1, r2 = Fraction(100 + p1, 100), Fraction(100 + p2, 100)
            v = Fraction(k) * r1 * r2
            q = (f"{who} {wp} do banku {k} zł. W pierwszym roku kapitał wzrósł o {p1}%, "
                 f"a w drugim roku o {p2}% (procent składany). "
                 f"Ile złotych będzie po tych dwóch latach?")  # fmt: skip
            wrong = [
                Fraction(k) * (1 + Fraction(p1 + p2, 100)),
                Fraction(k) * r1,
                Fraction(k) * r2,
                Fraction(k) * r1 * r1,
                Fraction(k + p1 + p2),
            ]
    o, i = choices(r, v, [w for w in wrong if w != v and w > 0])
    return Item("matematyczne", "procent składany", q, o, i, lv)


MATH_GEN = {
    "arytmetyka": arithmetic,
    "ułamki": fractions,
    "procenty": percents,
    "równania": equations,
    "zadanie tekstowe": word,
    "jednostki": units,
    "proporcje": proportions,
    "ułamki tekstowe": fraction_word,
    "procent składany": compound_percent,
}


# ---------------------------------------------------------------- analityczne (prawdziwe dane Wikidata)


def parse_date(s: str) -> tuple[int, int, int] | None:
    p = s.replace(" r.", "").split()
    if len(p) != 3 or p[1] not in MONTHS or not p[0].isdigit() or not p[2].lstrip("-").isdigit():
        return None
    return int(p[2]), MONTHS.index(p[1]) + 1, int(p[0])


def table(head: tuple[str, str], rows: list[tuple[str, str]]) -> str:
    return "\n".join([f"{head[0]} | {head[1]}"] + [f"{a} | {b}" for a, b in rows])


def analytic(r: random.Random, kind: str, facts: dict[str, list[dict]], lv: int) -> Item | None:
    if kind == "tabela: pierwiastki":
        pool = [f for f in facts["liczba_atomowa"] if f["obj"].isdigit()]
        rows = r.sample(pool, 4 + lv)
        z = {f["subj"]: int(f["obj"]) for f in rows}
        tab = table(("pierwiastek", "liczba atomowa"), [(f["subj"], f["obj"]) for f in rows])
        names = list(z)
        if lv == 1:
            v = max(names, key=z.get)
            q = f"Tabela (Wikidata):\n{tab}\nKtóry pierwiastek z tabeli ma największą liczbę atomową?"
            o = r.sample([n for n in names if n != v], 3) + [v]
            r.shuffle(o)
            return Item("analityczne", kind, q, tuple(o), o.index(v), lv, tuple(f["url"] for f in rows))
        if lv == 2:
            a, b = r.sample(names, 2)
            v = abs(z[a] - z[b])
            q = f"Tabela (Wikidata):\n{tab}\nO ile różnią się liczby atomowe pierwiastków {a} i {b}?"
            o, i = choices(r, v, [z[a] + z[b], v + 1, v - 1 if v > 1 else v + 2, max(z[a], z[b])])
            return Item("analityczne", kind, q, o, i, lv, tuple(f["url"] for f in rows))
        thr = sorted(z.values())[r.randint(1, len(z) - 2)]
        v = sum(1 for x in z.values() if x > thr)
        q = f"Tabela (Wikidata):\n{tab}\nIle pierwiastków z tabeli ma liczbę atomową większą niż {thr}?"
        o, i = choices(r, v, [v + 1, v - 1, len(z) - v, v + 2])
        return Item("analityczne", kind, q, o, i, lv, tuple(f["url"] for f in rows))
    if kind == "tabela: daty urodzenia":
        pool = [f for f in facts["data_urodzenia"] if parse_date(f["obj"]) and len(f["subj"]) <= 40]
        for _ in range(20):
            rows = r.sample(pool, 4 + (lv > 1))
            ds = {f["subj"]: parse_date(f["obj"]) for f in rows}
            if len({d[0] for d in ds.values()}) == len(ds):  # różne lata – jednoznaczna kolejność
                break
        else:
            return None
        tab = table(("osoba", "data urodzenia"), [(f["subj"], f["obj"]) for f in rows])
        names = list(ds)
        if lv in (1, 2):
            pick = min if r.random() < 0.5 else max
            v = pick(names, key=ds.get)
            word = "najwcześniej" if pick is min else "najpóźniej"
            q = f"Tabela (Wikidata):\n{tab}\nKto z tabeli urodził się {word}?"
            o = r.sample([n for n in names if n != v], 3) + [v]
            r.shuffle(o)
            return Item("analityczne", kind, q, tuple(o), o.index(v), lv, tuple(f["url"] for f in rows))
        a, b = r.sample(names, 2)
        v = abs(ds[a][0] - ds[b][0])
        q = f"Tabela (Wikidata):\n{tab}\nIle lat dzieli rok urodzenia osób: {a} i {b}?"
        o, i = choices(r, v, [v + 1, v - 1 if v > 1 else v + 2, v + 10, v * 2])
        return Item("analityczne", kind, q, o, i, lv, tuple(f["url"] for f in rows))
    if kind == "tabela: kontynenty":
        by: dict[str, str] = {}
        for f in facts["kontynent"]:
            by.setdefault(f["subj"], f["obj"])  # kraje z kilkoma kontynentami: pomijamy niżej
        multi = {s for s in by if sum(1 for f in facts["kontynent"] if f["subj"] == s) > 1}
        pool = [f for f in facts["kontynent"] if f["subj"] not in multi]
        rows = r.sample(pool, 5 + lv)
        conts = sorted({f["obj"] for f in rows})
        c = r.choice(conts)
        v = sum(1 for f in rows if f["obj"] == c)
        tab = table(("państwo", "kontynent"), [(f["subj"], f["obj"]) for f in rows])
        q = f"Tabela (Wikidata):\n{tab}\nIle państw z tabeli leży według tabeli na kontynencie: {c}?"
        o, i = choices(r, v, [v + 1, v - 1, len(rows) - v, v + 2])
        return Item("analityczne", kind, q, o, i, lv, tuple(f["url"] for f in rows))
    return None


def generate(n_per_kind: int, seed: int, facts: dict[str, list[dict]] | None = None, exclude: set[str] = frozenset(),
             gate_ngrams: set | None = None) -> list[Item]:  # fmt: skip
    """n zadań na rodzaj, poziomy 1–3 po równo; pomija hashe bramki LM i pytania dzielące 8-gram ze zbiorem bramki."""
    r = random.Random(seed)
    out, seen = [], set(exclude)
    kinds = [("m", k) for k in MATH] + ([("a", k) for k in ANALYTIC] if facts else [])
    for t, k in kinds:
        got, tries = 0, 0
        while got < n_per_kind and tries < n_per_kind * 50:
            tries += 1
            lv = 1 + got % 3
            it = MATH_GEN[k](r, lv) if t == "m" else analytic(r, k, facts, lv)
            if it is None or it.sha in seen or qhash(it.q) in seen:
                continue
            if gate_ngrams and ngrams(it.q, 8) & gate_ngrams:
                continue
            assert len(set(it.options)) == 4 and 0 <= it.answer < 4
            seen.add(it.sha)
            out.append(it)
            got += 1
    return out
