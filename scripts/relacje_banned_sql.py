"""Generuje supabase/myc_rel_banned.sql: słowa testów analogii i ich formy (relacje.banned_forms), żeby żadne pytanie
o relację – od samouka ani od mówcy – nie używało słownictwa testu. Test tests/test_relacje.py sprawdza zgodność.

  PYTHONPATH=src python3 scripts/relacje_banned_sql.py
"""

from pathlib import Path

from iot_mycelium.mesh import relacje

ROOT = Path(__file__).resolve().parents[1]


def render() -> str:
    words = sorted(relacje.banned_forms())
    arr = ",\n  ".join(
        ", ".join("'" + w.replace("'", "''") + "'" for w in words[i : i + 10]) for i in range(0, len(words), 10)
    )
    # plik SQL generowany ze stałej listy słów (cudzysłowy podwojone), nie zapytanie z danych
    return (
        "-- WYGENEROWANE: PYTHONPATH=src python3 scripts/relacje_banned_sql.py – nie edytować ręcznie.\n"  # noqa: S608
        "-- Słowa testów analogii (selfplay.REL + pytania analogii w results/czysta/parafrazy-*.json) i ich formy.\n"
        "create or replace function public.myc_rel_banned() returns text[] language sql immutable as $$ select array[\n  "
        + arr
        + "\n]::text[] $$;\n"
        "create or replace function public.myc_rel_has_banned(p_text text) returns boolean language sql immutable as $$\n"
        "  select exists (select 1 from regexp_split_to_table(lower(p_text), '[^[:alpha:]]+') w where w = any (myc_rel_banned()))\n"
        "$$;\n"
    )


if __name__ == "__main__":
    (ROOT / "supabase/myc_rel_banned.sql").write_text(render())
    print("zapisano", len(relacje.banned_forms()), "form")
