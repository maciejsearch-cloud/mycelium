"""Odciski stałych zbiorów testowych (bramka bez regresji): sha256 z etykiet testu "y0,y1,..." i liczba próbek.

Wynik: supabase/myc_eval_sets.sql. Ten sam odcisk liczy przeglądarka (engine.worker.ts → evalSet).
"""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ML = ROOT / "web" / "public" / "data" / "ml"


def labels(m: str, md: dict) -> list[int]:
    u = (ML / m / "test.bin").read_bytes()
    if md["format"] == "sparse":
        out, o = [], 0
        while o < len(u):
            y, n = struct.unpack_from("<HH", u, o)
            out.append(y)
            o += 4 + 2 * n
        return out
    rec = md["dim"] + 1
    return [u[i * rec + md["dim"]] for i in range(len(u) // rec)]


def main() -> None:
    meta = json.loads((ML / "meta.json").read_text())
    rows = []
    for m, md in meta.items():
        y = labels(m, md)
        assert len(y) == md["test"], (m, len(y))
        sha = hashlib.sha256(",".join(map(str, y)).encode()).hexdigest()
        rows.append(f"  ('{m}', {len(y)}, '{sha}')")
    sql = (
        "-- Stałe zbiory testowe (generuje scripts/eval_sets.py)\n"
        "insert into public.myc_eval_sets (model, n, sha) values\n" + ",\n".join(rows) + "\n"
        "on conflict (model) do update set n = excluded.n, sha = excluded.sha;\n"
    )
    (ROOT / "supabase" / "myc_eval_sets.sql").write_text(sql)
    print(sql)


if __name__ == "__main__":
    main()
