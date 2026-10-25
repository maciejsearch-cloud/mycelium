"""Test dymny dashboardu – uruchamia skrypt Streamlit bez przeglądarki (AppTest)."""

from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

SCRIPT = str(Path(__file__).resolve().parents[1] / "src" / "dashboard.py")

pytestmark = pytest.mark.slow


def _app():
    return AppTest.from_file(SCRIPT, default_timeout=180).run()


def _button(at, key):
    return next(b for b in at.button if b.key == key)


def test_dashboard_starts_with_all_tabs():
    at = _app()
    assert not at.exception
    assert [t.label for t in at.tabs] == [
        "🏃 Trening",
        "🤖 Auto-Evolution",
        "🧠 IQ",
        "🍄 Mycelium",
        "📋 Zadania i agenci",
    ]


def test_train_then_iq():
    at = _app()
    at.selectbox(key="task").set_value("and")
    at.slider(key="epochs").set_value(2000)
    _button(at, "train").click().run()
    assert not at.exception
    assert not at.error
    assert any(m.label == "Dokładność" for m in at.metric)
    _button(at, "iq_button").click().run()
    assert not at.exception
    assert any(m.label == "🧠 IQ" for m in at.metric)
    assert any(m.label == "🍄 Status grzybni" and m.value == "Aktywna" for m in at.metric)


def test_auto_evolution_runs():
    at = _app()
    at.multiselect(key="evo_tasks").set_value(["and", "or"])
    at.number_input(key="evo_attempts").set_value(2)
    at.selectbox(key="evo_scale").set_value(0.25)
    _button(at, "evo_start").click().run()
    assert not at.exception
    assert any(m.label == "🎯 Opanowane" for m in at.metric)


def test_reset_mycelium():
    at = _app()
    _button(at, "reset").click().run()
    assert not at.exception
