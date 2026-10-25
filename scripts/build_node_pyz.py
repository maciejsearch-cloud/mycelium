"""Samodzielny węzeł grzybni jako jeden plik (zipapp): tylko kod węzła (iot_mycelium.mesh).

Wynik: web/public/node/mycelium-node.pyz (artefakt publikowany na stronie demo; nie w repozytorium).
Uruchomienie: python3 mycelium-node.pyz  (pierwsze uruchomienie pyta o wątki i autostart; wymaga: torch, websockets)
albo bez pytań: python3 mycelium-node.pyz --join --name moj-wezel --threads 2
"""

from __future__ import annotations

import hashlib
import io
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "iot_mycelium"
OUT = ROOT / "web" / "public" / "node" / "mycelium-node.pyz"

MAIN = """import sys

if sys.version_info < (3, 10):
    sys.exit("Mycelium node: wymagany Python 3.10+")
try:
    import torch  # noqa: F401
    import websockets  # noqa: F401
except ImportError:
    sys.exit(
        "Brak zależności. Zainstaluj: pip install torch websockets "
        "--index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple"
    )
from iot_mycelium.mesh.node import main

main()
"""


def build() -> Path:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("__main__.py", MAIN)
        z.writestr("iot_mycelium/__init__.py", '"""Mycelium AI – samodzielny węzeł."""\n')
        for f in sorted((SRC / "mesh").glob("*.py")):
            z.writestr(f"iot_mycelium/mesh/{f.name}", f.read_text(encoding="utf-8"))
    OUT.write_bytes(b"#!/usr/bin/env python3\n" + buf.getvalue())
    OUT.chmod(0o755)
    (OUT.parent / "mycelium-node.pyz.sha256").write_text(
        f"{hashlib.sha256(OUT.read_bytes()).hexdigest()}  mycelium-node.pyz\n"
    )
    return OUT


if __name__ == "__main__":
    print(build())
