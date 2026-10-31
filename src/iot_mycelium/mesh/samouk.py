"""Samouk: zadania ze sprawdzalną odpowiedzią do samodzielnej nauki LM i wybór, czego uczyć się teraz (ciekawość).

Typy zadań (każde z odpowiedzią liczoną programem, wybór 1 z kilku):
  logika      – ``selfplay`` (16 kategorii, tylko zadania z listą odpowiedzi albo tak/nie/nie wiadomo),
  matematyka  – ``zadania`` (arytmetyka, ułamki, procenty, równania, zadania tekstowe),
  przypadki   – „Na jakie pytanie odpowiada słowo X w zdaniu …?” – zdanie z szablonu, przypadek znany z konstrukcji,
                formy rzeczowników z leksykonu Morfeusza 2 / SGJP (BSD-2-Clause),
  role        – „Co jest podmiotem / orzeczeniem / dopełnieniem / okolicznikiem w zdaniu …?” – rola znana z konstrukcji.

Zbiory próbne (``probe``) mają stałe ziarno i są wyłączone z treningu po hashu pytania; zbiór bramki LM (2000 pytań)
też (hash + 8-gramy słów) – bramka nie jest tu zmieniana. Wybór typów: ``choose`` (bandyta UCB na zmierzonych
błędach, niepewności i postępie nauki), każdy wybór z jawnym uzasadnieniem z liczb.
"""

from __future__ import annotations

import gzip
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path

from . import selfplay, zadania

TYPES = ("logika", "matematyka", "przypadki", "role")
PROBE_SEED, PROBE_N = 7, 40


@dataclass(frozen=True)
class MC:
    type: str
    kind: str
    q: str
    options: tuple[str, ...]
    answer: int
    level: int = 1

    @property
    def prompt(self) -> str:
        return self.q + "\nOdpowiedzi: " + "; ".join(self.options) + ".\nPodaj jedną odpowiedź."

    @property
    def sha(self) -> str:
        return selfplay.qhash(self.q)


# ---------------------------------------------------------------- przypadki
CASES = {  # przypadek: (pytanie, szablony zdań z {N})
    "nom": ("kto? co?", ["Tutaj jest {N}.", "Na zdjęciu widać, że {N} jest blisko.", "To jest {N}."]),
    "gen": ("kogo? czego?", ["Nie widzę {N}.", "Szukam {N}.", "Nie ma tu {N}."]),
    "dat": ("komu? czemu?", ["Przyglądam się {N}.", "Dzięki {N} zdążyliśmy.", "Uważnie przyglądamy się {N}."]),
    "acc": ("kogo? co?", ["Widzę {N}.", "Lubię {N}.", "Rysuję {N}."]),
    "inst": ("kim? czym?", ["Idę z {N}.", "Rozmawiam z {N}.", "Stoję przed {N}."]),
    "loc": ("o kim? o czym?", ["Myślę o {N}.", "Mówimy o {N}.", "Czytam o {N}."]),
}
NOUNS = ("kot", "pies", "dom", "książka", "drzewo", "rower", "samochód", "miasto", "rzeka", "ogród", "szkoła",
         "nauczyciel", "lekarz", "siostra", "brat", "okno", "stół", "kwiat", "ptak", "góra", "list", "most",
         "rodzina", "zegar", "jabłko", "chleb", "las", "statek", "pociąg", "koleżanka")  # fmt: skip
_FORMS: dict[str, dict[str, str]] | None = None


def noun_forms(lex_path: Path) -> dict[str, dict[str, str]]:
    """lemat → {przypadek: forma lp.} z leksykonu Morfeusza (tylko formy jednoznaczne co do lematu i przypadka)."""
    global _FORMS
    if _FORMS is None:
        d = json.loads(gzip.decompress(lex_path.read_bytes()))
        rules, tags, want = d["rules"], d["tags"], set(NOUNS)
        out: dict[str, dict[str, set[str]]] = {}
        for form, an in d["forms"].items():
            if not form.islower():
                continue
            for r, ti in an:
                cut, add, _ = (rules[r].split("|") + ["", ""])[:3]
                lemma = (form[: len(form) - int(cut)] if int(cut) else form) + add
                t = tags[ti].split(":")
                if lemma in want and t[0] == "subst" and t[1] == "sg" and t[2] in CASES:
                    out.setdefault(lemma, {}).setdefault(t[2], set()).add(form)
        _FORMS = {k: {c: sorted(f)[0] for c, f in v.items() if len(f) == 1} for k, v in out.items()}
        _FORMS = {k: v for k, v in _FORMS.items() if len(v) == len(CASES)}
    return _FORMS


def case_task(r: random.Random, forms: dict[str, dict[str, str]], level: int) -> MC:
    noun = r.choice(sorted(forms))
    case = r.choice(sorted(CASES))
    q_right, tpls = CASES[case]
    w = forms[noun][case]
    s = r.choice(tpls).format(N=w)
    if level >= 2:  # drugie zdanie z innym rzeczownikiem w innym przypadku jako zmyłka
        n2 = r.choice(sorted(set(forms) - {noun}))
        c2 = r.choice(sorted(set(CASES) - {case, "nom"}))
        s2 = r.choice(CASES[c2][1]).format(N=forms[n2][c2])
        s2 = s2[0].lower() + s2[1:]
        s = (
            s[:-1] + ", a potem " + s2
            if r.random() < 0.5
            else s2[0].upper() + s2[1:-1] + ", a potem " + s[0].lower() + s[1:]
        )
    wrong = r.sample(sorted({v[0] for v in CASES.values()} - {q_right}), 3)
    opts = [q_right, *wrong]
    r.shuffle(opts)
    q = f"W zdaniu „{s}” słowo „{w}” odpowiada na pytanie:"
    return MC("przypadki", case, q, tuple(opts), opts.index(q_right), level)


# ---------------------------------------------------------------- role w zdaniu
VERBS = (("czyta", "książkę"), ("maluje", "obraz"), ("naprawia", "rower"), ("pisze", "list"), ("myje", "okno"),
         ("ogląda", "film"), ("kupuje", "chleb"), ("piecze", "ciasto"), ("buduje", "domek"), ("sadzi", "drzewo"))  # fmt: skip
ADVS = ("w ogrodzie", "wieczorem", "w kuchni", "rano", "w szkole", "powoli", "w parku", "codziennie", "starannie")
ROLES = {"podmiot": 0, "orzeczenie": 1, "dopełnienie": 2, "okolicznik": 3}


def role_task(r: random.Random, level: int) -> MC:
    who = selfplay.PEOPLE[r.choice(selfplay.NAMES)][0]
    v, o = r.choice(VERBS)
    adv = r.choice(ADVS)
    parts = [who, v, o, adv]
    order = [0, 1, 2, 3]
    if level >= 2:
        while order == [0, 1, 2, 3]:
            r.shuffle(order)
    s = " ".join(parts[i] for i in order)
    s = s[0].upper() + s[1:] + "."
    role = r.choice(sorted(ROLES))
    opts = list(parts)
    r.shuffle(opts)
    right = parts[ROLES[role]]
    return MC("role", role, f"Co jest {_role_q(role)} w zdaniu „{s}”?", tuple(opts), opts.index(right), level)


def _role_q(role: str) -> str:
    return {
        "podmiot": "podmiotem",
        "orzeczenie": "orzeczeniem",
        "dopełnienie": "dopełnieniem",
        "okolicznik": "okolicznikiem",
    }[role]


# ---------------------------------------------------------------- wspólne
def _logic(r: random.Random, level: int) -> MC | None:
    t = selfplay.make(r.choice(selfplay.CATEGORIES), r, level)
    if t.kind in selfplay.TERNARY and t.answer in selfplay.TERNARY[t.kind]:
        opts = selfplay.TERNARY[t.kind]
    elif t.options and t.answer in t.options:
        opts = t.options
    else:
        return None
    return MC("logika", t.kind, t.question, tuple(opts), list(opts).index(t.answer), t.level)


def _math(r: random.Random, level: int) -> MC:
    k = r.choice(zadania.MATH)
    it = zadania.MATH_GEN[k](r, level)
    return MC("matematyka", it.kind, it.q, tuple(it.options), it.answer, it.level)


def make(typ: str, r: random.Random, level: int, forms: dict | None = None) -> MC | None:
    if typ == "logika":
        return _logic(r, level)
    if typ == "matematyka":
        return _math(r, level)
    if typ == "przypadki":
        return case_task(r, forms or {}, level)
    if typ == "role":
        return role_task(r, level)
    raise ValueError(typ)


def generate(typ: str, n: int, seed: int, exclude: set[str] = frozenset(), gate_ngrams: set | None = None,
             forms: dict | None = None) -> list[MC]:  # fmt: skip
    """n unikalnych zadań typu (poziomy 1–3 po równo), bez hashy z exclude i bez 8-gramów bramki."""
    r, seen, out, tries = random.Random(f"{typ}:{seed}"), set(exclude), [], 0
    while len(out) < n and tries < n * 60:
        tries += 1
        t = make(typ, r, 1 + len(out) % 3, forms)
        if t is None or t.sha in seen or len(set(t.options)) != len(t.options):
            continue
        if gate_ngrams and selfplay.ngrams(t.q, 8) & gate_ngrams:
            continue
        seen.add(t.sha)
        out.append(t)
    return out


def probe(typ: str, forms: dict | None = None, gate_ngrams: set | None = None) -> list[MC]:
    """Stały zbiór próbny typu (ziarno PROBE_SEED) – tylko do pomiaru, nigdy do treningu."""
    return generate(typ, PROBE_N, PROBE_SEED, gate_ngrams=gate_ngrams, forms=forms)


# ---------------------------------------------------------------- ciekawość: co uczyć teraz
def choose(stats: dict[str, dict], jobs: int, rounds: dict[str, int], c: float = 0.35, tau: float = 0.12) -> dict:
    """Bandyta UCB nad typami zadań.

    stats[typ] = {acc, p_right (średnie prawdopodobieństwo poprawnej odpowiedzi), progress (Δ trafności po ostatnim
    treningu z tym typem albo None)}; rounds[typ] = ile zadań treningu typ już dostał.
    Wartość = błąd (1 − acc) · 0,5 + niepewność (1 − p_right) · 0,3 + max(postęp, 0) · 2 + c·√(ln N / (1 + n_typ)).
    Przydział `jobs` zadań: softmax(wartość / τ), co najmniej 1 zadanie na typ (eksploracja), metoda największych reszt.
    Typ bez postępu po ≥ 3 rundach i z trafnością ≥ 0,95 dostaje mniej (opanowany)."""
    N = 1 + sum(rounds.values())
    val, why = {}, {}
    for t, s in stats.items():
        err, unc = 1 - s["acc"], 1 - s["p_right"]
        prog = s.get("progress")
        bonus = c * math.sqrt(math.log(N) / (1 + rounds.get(t, 0)))
        v = 0.5 * err + 0.3 * unc + 2 * max(prog or 0.0, 0.0) + bonus
        if s["acc"] >= 0.95 and rounds.get(t, 0) >= 3 and (prog or 0) <= 0:
            v *= 0.5
        val[t] = v
        why[t] = {"err": round(err, 4), "uncertainty": round(unc, 4), "progress": None if prog is None else round(prog, 4),
                  "explore": round(bonus, 4), "value": round(v, 4)}  # fmt: skip
    mx = max(val.values())
    w = {t: math.exp((v - mx) / tau) for t, v in val.items()}
    z = sum(w.values())
    share = {t: x / z for t, x in w.items()}
    left = jobs - len(share)
    raw = {t: share[t] * left for t in share}
    alloc = {t: 1 + int(raw[t]) for t in share}
    for t in sorted(share, key=lambda t: raw[t] - int(raw[t]), reverse=True)[: jobs - sum(alloc.values())]:
        alloc[t] += 1
    for t in why:
        why[t]["share"], why[t]["jobs"] = round(share[t], 4), alloc[t]
        why[t]["reason"] = reason(t, stats[t], why[t])
    return {"alloc": alloc, "why": why}


def reason(t: str, s: dict, w: dict) -> str:
    """Uzasadnienie wyboru z liczb (po polsku), bez ozdobników."""
    parts = [f"trafność {s['acc'] * 100:.0f}% na {s['n']} pytaniach próbnych"]
    if w["uncertainty"] >= 0.5:
        parts.append(f"mała pewność (średnio {s['p_right'] * 100:.0f}% na poprawną odpowiedź)")
    if s.get("progress") is not None:
        p = s["progress"] * 100
        parts.append(f"po ostatnim treningu {'+' if p >= 0 else ''}{p:.1f} pkt proc.")
    else:
        parts.append("jeszcze nie trenowany – sprawdzam, czy da się tu czegoś nauczyć")
    head = "najsłabszy obszar" if w["err"] >= 0.5 else "do utrwalenia" if w["err"] >= 0.2 else "prawie opanowany"
    return f"{head}: " + ", ".join(parts)
