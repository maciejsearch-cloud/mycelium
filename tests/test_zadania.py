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
