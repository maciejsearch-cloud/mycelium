"""Ładowanie odpowiedzi kontrolnych bieżącej rundy do ``myc_gold`` i wycofanie poprzednich (odwracalnie).

Odpowiedzi czyta wyłącznie z ``.gold/*.json`` (w .gitignore; tworzą je generatory z tajnym ``MYC_GOLD_SEED``,
zob. scripts/goldkit.py) i wysyła prosto do bazy przez Supabase Management API (``SUPABASE_ACCESS_TOKEN``).
Nic nie drukuje poza liczbami – żadnych odpowiedzi ani kluczy.

    python scripts/gold_rotate.py --plan     # tylko liczby z plików .gold/ i stan bazy
    python scripts/gold_rotate.py --apply    # migracja + wstawienie rundy + wycofanie starszych rund (1 transakcja)
    python scripts/gold_rotate.py --undo     # przywraca poprzednią rundę, bieżącą wycofuje (bez usuwania)
"""

# ruff: noqa: S608 – zapytania składane z liczby rundy i danych z .gold/ (lokalne, w cudzysłowie dolarowym, sprawdzone)
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import goldkit  # noqa: E402

REF = os.environ.get("MYC_SUPABASE_REF", "agortpieeygmcttjwjfx")
NAMES = ("qa", "captcha", "lexicon", "logic", "zadania")


def sql(q: str, read_only: bool = False):
    tok = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if not tok:
        raise SystemExit("brak SUPABASE_ACCESS_TOKEN")
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": q, "read_only": read_only}).encode(),
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json", "User-Agent": "myc-gold-rotate"},
    )
    try:
        return json.loads(urllib.request.urlopen(req, timeout=300).read())  # noqa: S310 – stały adres https
    except urllib.error.HTTPError as e:
        raise SystemExit(f"baza: {e.code} {e.read().decode()[:300]}") from None


def load() -> list[dict]:
    rows: list[dict] = []
    for n in NAMES:
        p = goldkit.GOLD_DIR / f"{n}.json"
        if not p.exists():
            raise SystemExit(f"brak {p} – uruchom generator z MYC_GOLD_SEED")
        d = json.loads(p.read_text())
        if d["round"] != goldkit.ROUND:
            raise SystemExit(f"{p}: runda {d['round']} ≠ {goldkit.ROUND}")
        rows += d["rows"]
    ids = [r["question_id"] for r in rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("powtórzone identyfikatory między plikami")
    return rows


def kind(q: str) -> str:
    return q[:2] if q.startswith("c") else q[:1]


def state() -> list:
    cols = sql("select 1 from information_schema.columns where table_name = 'myc_gold' and column_name = 'round'", True)
    if not cols:
        return sql("select 1 round, count(*) n, count(*) active, null retired_at from myc_gold", read_only=True)
    return sql(
        "select round, count(*) n, count(*) filter (where retired_at is null) active, max(retired_at) retired_at "
        "from myc_gold group by 1 order by 1",
        read_only=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan", action="store_true")
    g.add_argument("--apply", action="store_true")
    g.add_argument("--undo", action="store_true")
    a = ap.parse_args()
    R = goldkit.ROUND
    if a.undo:
        sql(
            f"begin; update myc_gold set retired_at = now() where round = {R} and retired_at is null; "
            f"update myc_gold set retired_at = null where round < {R} and retired_at = "
            f"(select max(retired_at) from myc_gold where round < {R}); commit;"
        )
        print(json.dumps(state()))
        return
    rows = load()
    print("runda", R, "wierszy", len(rows), dict(sorted(Counter(kind(r["question_id"]) for r in rows).items())))
    if a.plan:
        print("baza teraz:", json.dumps(state()))
        return
    mig = (ROOT / "supabase" / "myc_gold_rotation.sql").read_text()
    payload = json.dumps(rows, ensure_ascii=False)
    if "$gold$" in payload:
        raise SystemExit("niedozwolony znacznik w danych")
    q = (
        "begin;\n" + mig + "\n"
        f"do $$ begin if exists (select 1 from myc_gold g join jsonb_array_elements($gold${payload}$gold$::jsonb) x "
        f"on g.question_id = x->>'question_id' where g.round <> {R}) then "
        "raise exception 'kolizja identyfikatorów z inną rundą'; end if; end $$;\n"
        f"insert into myc_gold (question_id, answer, round) select x->>'question_id', x->>'answer', {R} "
        f"from jsonb_array_elements($gold${payload}$gold$::jsonb) x "
        "on conflict (question_id) do update set answer = excluded.answer, retired_at = null;\n"
        f"update myc_gold set retired_at = now() where round < {R} and retired_at is null;\n"
        "commit;"
    )
    sql(q)
    print("baza po:", json.dumps(state()))


if __name__ == "__main__":
    main()
