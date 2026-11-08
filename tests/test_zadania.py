import json
import re
from fractions import Fraction
from pathlib import Path

from iot_mycelium.mesh import zadania

ROOT = Path(__file__).resolve().parents[1]


def facts():
    out: dict[str, list[dict]] = {}
    for f in json.loads((ROOT / "web" / "public" / "data" / "seed" / "facts.json").read_text())["facts"]:
        out.setdefault(f["rel"], []).append(f)
    return out


def test_generate_shape_and_determinism():
    a = zadania.generate(6, 3, facts())
    b = zadania.generate(6, 3, facts())
    assert [x.sha for x in a] == [x.sha for x in b]
    assert len(a) == 6 * (len(zadania.MATH) + len(zadania.ANALYTIC))
    assert len({x.sha for x in a}) == len(a)
    for it in a:
        assert len(set(it.options)) == 4 and it.code in "abcd"
        assert it.level in (1, 2, 3)


def side(expr: str, x: int) -> int:
    e = re.sub(r"(\d)x", r"\1*X", expr.replace("−", "-")).replace("x", "X")
    return eval(e, {"X": x})  # noqa: S307 – wyrażenie z własnego generatora


def test_arithmetic_and_fractions_are_correct():
    for it in zadania.generate(30, 5):
        right = it.options[it.answer]
        if it.kind == "arytmetyka":
            expr = (
                re.search(r"Ile to jest (.+?)\?", it.q).group(1).replace("×", "*").replace(":", "/").replace("−", "-")
            )
            assert Fraction(eval(expr)) == Fraction(right)  # noqa: S307 – wyrażenie z własnego generatora
        if it.kind == "ułamki":
            expr = re.search(r"Ile to jest (.+?)\?", it.q).group(1)
            x, op, y = expr.split(" ")
            x, y = Fraction(x), Fraction(y)
            v = {"+": x + y, "×": x * y, ":": x / y}[op]
            assert v == Fraction(right)
        if it.kind == "równania":
            m = re.search(r"równanie: (.+) = (.+)\. Ile", it.q)
            assert side(m.group(1), int(right)) == side(m.group(2), int(right))


def test_analytic_answer_follows_from_table():
    for it in zadania.generate(12, 7, facts()):
        if it.kind != "tabela: pierwiastki" or "największą" not in it.q:
            continue
        rows = [r.split(" | ") for r in it.q.split("\n")[2:-1]]
        best = max(rows, key=lambda r: int(r[1]))[0]
        assert it.options[it.answer] == best
        assert all(u.startswith("https://www.wikidata.org/wiki/Q") for u in it.sources)


def test_gate_exclusion():
    base = zadania.generate(3, 9)
    blocked = zadania.generate(3, 9, exclude={base[0].sha})
    assert base[0].sha not in {x.sha for x in blocked}


def test_units_and_proportions_answers():
    """Odpowiedzi liczone programem: jednostki i proporcje (kl. 3 / 6–7)."""
    for it in zadania.generate(40, 11):
        right = it.options[it.answer]
        if it.kind == "jednostki":
            if "centymetrów" in it.q:
                m = re.search(r"(\d+) m (\d+) cm", it.q)
                assert int(right) == int(m.group(1)) * 100 + int(m.group(2))
            elif "metrów" in it.q and "km" in it.q:
                m = re.search(r"(\d+) km(?: (\d+) m)?", it.q)
                assert int(right) == int(m.group(1)) * 1000 + int(m.group(2) or 0)
            elif "minut" in it.q:
                m = re.search(r"(\d+) h(?: (\d+) min)?", it.q)
                assert int(right) == int(m.group(1)) * 60 + int(m.group(2) or 0)
            elif "dekagramów" in it.q:
                m = re.search(r"(\d+) kg (\d+) dag", it.q)
                assert int(right) == int(m.group(1)) * 100 + int(m.group(2))
            elif "groszy" in it.q:
                m = re.search(r"(\d+) zł (\d+) gr", it.q)
                assert int(right) == int(m.group(1)) * 100 + int(m.group(2))
            elif "godzin" in it.q and "dni" in it.q or ("godzin" in it.q and "dzień" in it.q):
                m = re.search(r"(\d+) (?:dni|dzień) (\d+) h", it.q)
                assert int(right) == int(m.group(1)) * 24 + int(m.group(2))
            elif "milimetrów" in it.q:
                m_m = re.search(r"(\d+) m(?!m)", it.q)
                cm = re.search(r"(\d+) cm", it.q)
                mm = re.search(r"(\d+) mm", it.q)
                assert int(right) == (int(m_m.group(1)) if m_m else 0) * 1000 + (
                    int(cm.group(1)) if cm else 0
                ) * 10 + int(mm.group(1))
        if it.kind == "proporcje":
            if "proporcji" in it.q:
                m = re.search(r"(\d+) : (\d+) = (\d+) : x", it.q)
                a, b, ak = map(int, m.groups())
                assert a != b and a * int(right) == b * ak
            elif "mąki" in it.q:
                m = re.search(r"Na (\d+) osob\w+ potrzeba (\d+) dag.*na (\d+) osób", it.q)
                n0, amt, n1 = map(int, m.groups())
                assert int(right) == amt * n1 // n0
            elif "mapie" in it.q:
                m = re.search(r"skali 1:(\d+) odcinek ma (\d+) cm", it.q)
                scale, cm = map(int, m.groups())
                meters = cm * scale // 100
                assert int(right) == (meters // 1000 if "kilometrów" in it.q else meters)


def _pl_dec(s: str) -> Fraction:
    return Fraction(s.replace(",", "."))


def test_fraction_word_and_compound_percent_answers():
    """Odpowiedzi liczone programem: ułamki tekstowe i procent składany (kl. 6–7)."""
    seen = {"ułamki tekstowe": set(), "procent składany": set()}
    for it in zadania.generate(48, 13):
        right = it.options[it.answer]
        if it.kind == "ułamki tekstowe":
            seen[it.kind].add(it.level)
            if "kg jabłek" in it.q:
                m = re.search(r"kupił(?:a)? (\d+,\d+) kg jabłek i (\d+,\d+) kg gruszek", it.q)
                assert m, it.q
                v = _pl_dec(m.group(1)) + _pl_dec(m.group(2))
            elif re.search(r"Ile to jest \d+/\d+ z tej liczby", it.q):
                m = re.search(r"miał(?:a)? (\d+) .+\. Ile to jest (\d+)/(\d+) z tej liczby", it.q)
                assert m, it.q
                v = Fraction(int(m.group(1)) * int(m.group(2)), int(m.group(3)))
            elif re.search(r"Ile to jest \d+,\d+ z tej liczby", it.q):
                m = re.search(r"miał(?:a)? (\d+) .+\. Ile to jest (\d+,\d+) z tej liczby", it.q)
                assert m, it.q
                v = Fraction(int(m.group(1))) * _pl_dec(m.group(2))
            elif "tej kwoty, a potem" in it.q and "reszty" in it.q:
                m = re.search(
                    r"miał(?:a)? (\d+) zł\. Najpierw \w+ (\d+)/(\d+) tej kwoty, a potem (\d+/\d+|\d+,\d+) reszty",
                    it.q,
                )
                assert m, it.q
                n, a, b, second = int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
                frac2 = Fraction(second) if "/" in second else _pl_dec(second)
                v = Fraction(n) * (1 - Fraction(a, b)) * (1 - frac2)
            else:
                raise AssertionError(f"nierozpoznane pytanie: {it.q}")
            assert Fraction(right) == v
        if it.kind == "procent składany":
            seen[it.kind].add(it.level)
            mk = re.search(r"do banku (\d+) zł", it.q)
            assert mk, it.q
            k = int(mk.group(1))
            two = re.search(r"pierwszym roku kapitał wzrósł o (\d+)%, a w drugim roku o (\d+)%", it.q)
            if two:
                p1, p2 = int(two.group(1)), int(two.group(2))
                v = Fraction(k) * Fraction(100 + p1, 100) * Fraction(100 + p2, 100)
            else:
                mp = re.search(r"(?:dolicza |lokatę )(\d+)%", it.q)
                assert mp, it.q
                p = int(mp.group(1))
                if "po 1 roku" in it.q:
                    years = 1
                elif "po 2 latach" in it.q:
                    years = 2
                elif "po 3 latach" in it.q:
                    years = 3
                else:
                    raise AssertionError(it.q)
                v = Fraction(k)
                for _ in range(years):
                    v *= Fraction(100 + p, 100)
            assert Fraction(right) == v
    assert seen["ułamki tekstowe"] == {1, 2, 3}
    assert seen["procent składany"] == {1, 2, 3}
