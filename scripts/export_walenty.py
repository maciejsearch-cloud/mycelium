"""Walenty (słownik walencyjny IPI PAN, CC BY-SA 4.0) → wymagania czasowników jako pytania rozbioru.

    python scripts/export_walenty.py --walenty walenty_20210712_verbs_verified.txt --out web/public/data/rozbior/walenty.json.gz

Bierzemy schematy „pewny” bez frazeologii (lex) i każdą pozycję zamieniamy na pytanie przypadka:
subj{np(str)} → KTO/CO, obj{np(str)} → KOGO/CO, {np(dat)} → KOMU/CZEMU, {prepnp(z,inst)} → Z KIM/CZYM, {xp(locat)} → GDZIE …
Dla każdego czasownika do 4 najkrótszych schematów (różnych zbiorów pytań). Czasowniki przekazania (dać, podarować…)
= mają schemat subj + obj + np(dat) i należą do ręcznej listy znaczeń „X przekazuje Y-owi Z” → wnioskowanie „kto ma teraz”.
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import re
from pathlib import Path

CASE = {
    "str": "KOGO/CO",
    "gen": "KOGO/CZEGO",
    "dat": "KOMU/CZEMU",
    "acc": "KOGO/CO",
    "inst": "KIM/CZYM",
    "loc": "O KIM/O CZYM",
}
PREP_CASE = {
    "gen": "KOGO/CZEGO",
    "dat": "KOMU/CZEMU",
    "acc": "KOGO/CO",
    "inst": "KIM/CZYM",
    "loc": "KIM/CZYM",
    "str": "KOGO/CO",
}
XP = {
    "locat": "GDZIE",
    "temp": "KIEDY",
    "adl": "DOKĄD",
    "abl": "SKĄD",
    "mod": "JAK",
    "caus": "DLACZEGO",
    "dest": "PO CO",
    "perl": "KTÓRĘDY",
    "dur": "JAK DŁUGO",
}
TRANSFER = [
    "dać",
    "podać",
    "podarować",
    "darować",
    "oddać",
    "przekazać",
    "wręczyć",
    "sprzedać",
    "pożyczyć",
    "wysłać",
    "przesłać",
    "posłać",
    "dostarczyć",
    "przynieść",
    "zanieść",
    "podrzucić",
    "ofiarować",
    "sprezentować",
    "przydzielić",
    "udostępnić",
    "powierzyć",
    "zostawić",
    "doręczyć",
]


def pos_q(p: str) -> str | None:
    head, _, body = p.partition("{")
    body = body.rstrip("}")
    alts = body.split(";")
    a = alts[0]
    if a.startswith("lex(") or "lex(" in body or a in ("refl", "recip", "E", "nonch"):
        return None
    if "subj" in head:
        return "KTO/CO"
    m = re.match(r"np\((\w+)\)", a)
    if m:
        return "KOGO/CO" if "obj" in head else CASE.get(m.group(1))
    m = re.match(r"prep[n]?[c]?p\((\w+),(\w+)", a)
    if m:
        if m.group(1) == "o" and m.group(2) == "loc":
            return "O KIM/O CZYM"
        return f"{m.group(1).upper()} {PREP_CASE.get(m.group(2), 'KOGO/CO')}"
    m = re.match(r"xp\((\w+)", a)
    if m:
        return XP.get(m.group(1))
    if a.startswith("cp(") or a.startswith("ncp("):
        return "CO (zdanie)"
    if a.startswith("infp"):
        return "CO ROBIĆ"
    if a.startswith("advp"):
        return "JAK"
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--walenty", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--lemmas", help="ograniczenie do lematów (plik, jeden na wiersz)")
    a = ap.parse_args()
    keep = set(Path(a.lemmas).read_text(encoding="utf-8").split("\n")) if a.lemmas else None
    verbs: dict[str, dict] = {}
    for line in Path(a.walenty).read_text(encoding="utf-8").splitlines():
        if line.startswith("%") or ":" not in line:
            continue
        parts = [x.strip() for x in line.rstrip("\n").split(":", 5)]
        if len(parts) < 6:
            continue
        lemma, opin, neg, _pred, aspect, schema = parts
        if opin != "pewny" or (keep is not None and lemma not in keep):
            continue
        qs = []
        bad = False
        for p in schema.split(" + "):
            q = pos_q(p.strip())
            if q is None and "lex(" in p:
                bad = True
                break
            if q and q not in qs:
                qs.append(q)
        if bad or not qs:
            continue
        v = verbs.setdefault(lemma, {"aspect": aspect, "schemas": [], "raw": []})
        if qs not in v["schemas"]:
            v["schemas"].append(qs)
            v["raw"].append(schema)
    out = {}
    for lemma, v in verbs.items():
        order = sorted(range(len(v["schemas"])), key=lambda i: (len(v["schemas"][i]), i))[:4]
        e = {"a": v["aspect"], "s": [v["schemas"][i] for i in order]}
        if lemma in TRANSFER:
            tr = [v["raw"][i] for i, s in enumerate(v["schemas"]) if {"KTO/CO", "KOGO/CO", "KOMU/CZEMU"} <= set(s)]
            if tr:
                e["transfer"] = tr[0]
        out[lemma] = e
    meta = {
        "source": "Walenty – słownik walencyjny języka polskiego (IPI PAN), wersja 2021-07-12, schematy zweryfikowane",
        "url": "https://zil.ipipan.waw.pl/Walenty",
        "download": "https://walenty.ipipan.waw.pl/pobieranie_slownika/text/",
        "license": "CC BY-SA 4.0",
        "verbs": len(out),
        "transfer": sorted(k for k, e in out.items() if "transfer" in e),
    }
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0, compresslevel=9) as f:
        f.write(json.dumps({"meta": meta, "verbs": out}, ensure_ascii=False, separators=(",", ":")).encode())
    Path(a.out).write_bytes(buf.getvalue())
    print(meta["verbs"], meta["transfer"], len(buf.getvalue()))


if __name__ == "__main__":
    main()
