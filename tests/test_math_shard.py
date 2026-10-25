import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import export_math_shard as X  # noqa: E402

from iot_mycelium.mesh import selfplay, zadania  # noqa: E402


def test_math_shard_excludes_round1_and_gate():
    held = X.held_out(24)
    r1 = zadania.generate(24, 1)
    assert {selfplay.qhash(it.q) for it in r1} <= held
    gate_q = r1[0].q  # udajemy, że to pytanie jest w zbiorze bramki
    items = X.build(20, 1000, held, {selfplay.qhash(gate_q)}, set())
    assert len(items) == 20 * len(zadania.MATH)
    hs = [selfplay.qhash(it.q) for it in items]
    assert len(set(hs)) == len(hs) and not set(hs) & held
    assert all(it.type == "matematyczne" and 0 <= it.answer < 4 for it in items)


def test_math_prompt_matches_measurement():
    it = zadania.generate(1, 5)[0]
    p = X.prompt(it)
    assert p.startswith(it.q) and "; ".join(it.options) in p and p.endswith("Podaj jedną odpowiedź.")
