"""Krok 2: trening parsera na zatwierdzonych rozbiorach z Weryfikuj.

  PY scripts/rozbior_votes.py            # pobiera myc_parse_train, strażnik UD dev/test, zapis zdań
  PY scripts/rozbior_votes.py --train    # + dostrajanie od v0 i pomiar na całym teście UD (przed/po)

Poniżej glosy.MIN_PARSES zatwierdzonych zdań nie trenujemy – raport mówi to wprost (results/rozbior/votes-status.json).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from iot_mycelium.rozbior import glosy, model, trening  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--data", default="web/public/data/rozbior")
ap.add_argument("--init", default="/workspace/data/rozbior/rb-v0.bin")
ap.add_argument("--out", default="/workspace/data/rozbior/votes")
ap.add_argument("--train", action="store_true")
ap.add_argument("--min", type=int, default=glosy.MIN_PARSES)
a = ap.parse_args()

d = Path(a.data)
held = trening.read_split(d, "dev") + trening.read_split(d, "test")
rows = glosy.fetch()
sents, st = glosy.build(rows, glosy.Guard(held))
now = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
status = {"generated_at": now, **st, "min": a.min, "trained": False}
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
(out / "votes.json").write_text(json.dumps({"sents": sents}, ensure_ascii=False))
print(
    f"zatwierdzone: {st['rows']}, odrzucone przez strażnika (UD dev/test): {st['leak']}, niepoprawne: {st['invalid']}, do treningu: {st['used']}"
)
if st["used"] < a.min:
    status["note"] = f"za mało zatwierdzonych rozbiorów ({st['used']} < {a.min}) – trening nie był uruchomiony"
    print(status["note"])
elif a.train:
    bin_ = out / "rb-votes.bin"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "iot_mycelium.rozbior.trening",
            "--data",
            a.data,
            "--init",
            a.init,
            "--votes",
            str(out / "votes.json"),
            "--epochs",
            "2",
            "--lr",
            "5e-4",
            "--out",
            str(bin_),
        ],
        check=True,
        env={**os.environ, "PYTHONPATH": "src"},
    )
    test = trening.read_split(d, "test")
    H0, W0 = model.load(Path(a.init).read_bytes())
    H1, W1 = model.load(bin_.read_bytes())
    status["before"] = trening.evaluate_np(H0, W0, test)
    status["test"] = trening.evaluate_np(H1, W1, test)
    status["trained"] = True
    print(f"role-F1 test: {status['before']['role_f1']} → {status['test']['role_f1']}")
Path("results/rozbior").mkdir(parents=True, exist_ok=True)
Path("results/rozbior/votes-status.json").write_text(json.dumps(status, ensure_ascii=False, indent=1))
