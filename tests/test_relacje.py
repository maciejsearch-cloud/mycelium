import re
from pathlib import Path

from iot_mycelium.mesh import relacje

ROOT = Path(__file__).resolve().parents[1]


def test_proposals_are_questions_only():
    ps = relacje.samouk_proposals(7, 6)
    assert ps and len(ps) <= 6
    for p in ps:
        assert p["question"].endswith("?")
        assert p["kind"] in relacje.KINDS
        # żadnej odpowiedzi: druga strona relacji nie pojawia się w pytaniu
        answers = {b for k, v in relacje.selfplay.REL.items() for a, b in v if a == p["word"]}
        assert answers
        assert not any(b in p["question"] or b in p["reason"] for b in answers)


def test_templates_match_sql():
    sql = (ROOT / "supabase/myc_rel.sql").read_text()
    for kind, tpl in relacje.KINDS.items():
        pre, post = tpl.split("{w}")
        assert re.search(rf"when '{kind}' then '{re.escape(pre)}' \|\| p_word \|\| '{re.escape(post)}'", sql), kind
