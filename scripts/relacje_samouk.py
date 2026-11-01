"""Samouk proponuje pytania o relacje (src/iot_mycelium/mesh/relacje.py) – zapis do myc_rel_questions przez
Management API (SUPABASE_ACCESS_TOKEN właścicielki; nic nie jest wypisywane). Tylko pytania, nigdy odpowiedzi.

  PYTHONPATH=src python3 scripts/relacje_samouk.py [--n 6] [--dry]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from iot_mycelium.mesh import relacje  # noqa: E402

PROJECT = "agortpieeygmcttjwjfx"


def sql(q: str):
    r = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
        data=json.dumps({"query": q}).encode(),
        headers={
            "Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
            "Content-Type": "application/json",
            "User-Agent": "myc-relacje",
        },  # fmt: skip
        method="POST",
    )
    return json.loads(urllib.request.urlopen(r, timeout=120).read())  # noqa: S310


def lit(x: str) -> str:
    return "'" + x.replace("'", "''") + "'"


def propose(n: int = 6, dry: bool = False) -> list[dict]:
    known = {(r["kind"], r["word"]) for r in sql("select kind, word from myc_rel_questions where room = 'main'")}
    seed = int(time.strftime("%Y%m%d%H", time.gmtime()))
    # słownictwo zatwierdzone przez ludzi: znaczenia z czatu i jednowyrazowe tematy strzępków od ludzi
    vocab = [r["w"] for r in sql("select word w from myc_meanings where room = 'main' and status = 'approved'")]
    vocab += [r["w"] for r in sql(
        "select distinct lower(subj) w from myc_frags where room = 'main' and status = 'verified' and layer = 0"
        " and source in ('owner', 'consensus', 'teach') and subj ~ '^[[:alpha:]]+$'"
    )]  # fmt: skip
    props = relacje.samouk_proposals(seed, n, known, vocab)
    if not dry:
        for p in props:
            sql(
                f"select myc_rel_propose({lit(p['kind'])}, {lit(p['word'])}, 'samouk', {lit(p['reason'])}, {lit(p['question'])})"  # noqa: S608 – wartości przez lit()
            )
    return props


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    for p in propose(a.n, a.dry):
        print(p["kind"], "|", p["question"])
