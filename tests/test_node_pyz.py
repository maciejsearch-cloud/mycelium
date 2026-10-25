import importlib.util
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_pyz_contains_rozbior_package(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("build_node_pyz", ROOT / "scripts" / "build_node_pyz.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "OUT", tmp_path / "mycelium-node.pyz")
    names = set(zipfile.ZipFile(mod.build()).namelist())
    # rbwork importuje ..rozbior – bez tych plików węzeł PC nie wystartowałby
    assert "iot_mycelium/mesh/rbwork.py" in names
    for n in ("__init__", "analiza", "model", "zbior", "trening", "miary"):
        assert f"iot_mycelium/rozbior/{n}.py" in names
