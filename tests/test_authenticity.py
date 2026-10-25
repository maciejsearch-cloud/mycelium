"""Strażnik autentyczności: dane syntetyczne tylko w testach, nigdy w danych publikowanych dla UI."""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "web" / "public" / "data"


def _walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            yield k, v
            yield from _walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v)


def test_public_data_has_no_synthetic_results():
    for p in PUBLIC.glob("*.json"):
        data = json.loads(p.read_text())
        assert not any(k == "synthetic" and v is True for k, v in _walk(data)), f"{p.name}: dane syntetyczne w UI"


def test_synthetic_generators_only_in_datasets_module():
    # generatory _synthetic_* żyją wyłącznie w datasets.py (odpowiedniki do testów offline/CI)
    for p in list((ROOT / "src").rglob("*.py")) + list((ROOT / "scripts").rglob("*.py")):
        if p.name == "datasets.py":
            continue
        assert not re.search(r"_synthetic_\w+\(", p.read_text()), f"{p}: wywołanie generatora syntetycznego"


def test_export_refuses_synthetic(tmp_path):
    bad = tmp_path / "ai.json"
    bad.write_text(json.dumps({"synthetic": True, "agents": []}))
    (tmp_path / "s.json").write_text("{}")
    r = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "export_frontend_data.py"),
            "--ai-only",
            "--ai",
            str(bad),
            "--out",
            str(tmp_path / "s.json"),
        ],
        capture_output=True,
        text=True,
    )
    assert r.returncode != 0 and "syntetyczn" in (r.stdout + r.stderr)


def test_ml_shards_match_meta_and_do_not_leak_into_test():
    # każdy zbiór ma dokładnie tyle odłamków, ile podaje meta.json; trening nie zawiera wierszy walidacji/testu
    ml = PUBLIC / "ml"
    meta = json.loads((ml / "meta.json").read_text())
    fm = meta["fashion"]
    row = fm["dim"] + 1
    files = sorted((ml / "fashion").glob("train-*.bin"))
    assert len(files) == fm["shards"]
    held = set()
    for nm in ("val", "test"):
        b = (ml / "fashion" / f"{nm}.bin").read_bytes()
        held |= {b[i : i + row] for i in range(0, len(b), row)}
    seen = set()
    for f in files:
        b = f.read_bytes()
        assert len(b) == fm["per_shard"] * row, f.name
        rows = {b[i : i + row] for i in range(0, len(b), row)}
        seen |= rows
    assert not (seen & held), "wiersze testu/walidacji w odłamkach treningowych"
    assert len(seen) > 0.99 * fm["shards"] * fm["per_shard"]
