"""Odcisk reguł rozbioru do testu zgodności Python ↔ TypeScript (web/scripts/rozbior-parity.mjs).

    python scripts/rozbior_parity_fixture.py            # zapisuje web/public/data/rozbior/parity.json
    python scripts/rozbior_parity_fixture.py --check    # sprawdza, czy plik jest aktualny (test w CI)

Dla pierwszych N zdań testu UD (złote drzewa) – sha256 kanonicznego JSON analizy. Bez wag modelu.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from iot_mycelium.rozbior import analiza  # noqa: E402

OUT = ROOT / "web" / "public" / "data" / "rozbior" / "parity.json"
N = 400


def canon(x) -> str:
    return json.dumps(x, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def build() -> dict:
    out = {"n": 0, "sha": []}
    for name in ("test-pdb.json.gz", "test-lfg.json.gz"):
        ss = json.loads(gzip.decompress((ROOT / "web/public/data/rozbior" / name).read_bytes()))["sents"][: N // 2]
        for s in ss:
            out["sha"].append(hashlib.sha256(canon(analiza.analyse(s["toks"])).encode()).hexdigest()[:16])
    out["n"] = len(out["sha"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    cur = build()
    if a.check:
        old = json.loads(OUT.read_text())
        if old != cur:
            print("web/public/data/rozbior/parity.json nieaktualny – uruchom scripts/rozbior_parity_fixture.py")
            return 1
        return 0
    OUT.write_text(json.dumps(cur) + "\n")
    print(cur["n"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
