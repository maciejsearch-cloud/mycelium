import re
from pathlib import Path

from iot_mycelium.mesh import relacje

ROOT = Path(__file__).resolve().parents[1]


def test_proposals_never_use_test_words():
    vocab = ["lis", "nora", "kot", "piekarz", "wysoki", "krawiec", "głęboki"]  # słowa testu muszą odpaść
    for seed in range(5):
        for p in relacje.samouk_proposals(seed, 12, vocab=vocab):
            assert p["question"].endswith("?")
            assert p["kind"] in relacje.KINDS
            assert not relacje.mentions_test_word(p["question"] + " " + p["word"] + " " + p["reason"]), p


def test_banned_covers_test_vocabulary_and_forms():
    b = relacje.banned_forms()
    for v in relacje.selfplay.REL.values():
        for a, c in v:
            assert a in b and c in b
    assert {"norze", "koty", "kopiec", "przeczytać"} <= b


def test_banned_sql_is_generated_from_python():
    import importlib.util

    spec = importlib.util.spec_from_file_location("g", ROOT / "scripts/relacje_banned_sql.py")
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    assert (ROOT / "supabase/myc_rel_banned.sql").read_text() == g.render()


def test_templates_match_sql():
    sql = (ROOT / "supabase/myc_rel.sql").read_text()
    for kind, tpl in relacje.KINDS.items():
        pre, post = tpl.split("{w}")
        assert re.search(rf"when '{kind}' then '{re.escape(pre)}' \|\| p_word \|\| '{re.escape(post)}'", sql), kind
