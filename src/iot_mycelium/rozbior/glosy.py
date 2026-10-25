"""Zatwierdzone rozbiory z Weryfikuj (myc_parse_train) → zdania treningowe parsera.

Uczciwie o tym, co głosujący faktycznie sprawdzają: części zdania (i opcjonalnie UPOS / nadrzędnik w poprawce).
Dlatego:
- „confirmed”: nadzorujemy nadrzędnik i relację całego drzewa (rozbiór uznany za poprawny);
- „corrected”: poprawka {i, part?, upos?, head?} – nadrzędnik/UPOS z poprawki, relacja z mapy część→deprel
  tylko gdy jednoznaczna, inaczej maskowana;
- lematy i cechy morfologiczne NIGDY nie są nadzorowane z głosów (nikt ich nie weryfikował) – maska (-100).
Strażnik: zdania, które (po normalizacji) występują w UD dev/test albo dzielą z nimi 8-gram wyrazów, są odrzucane,
żeby trening na głosach nie zawyżył wyników na zbiorze testowym.
"""

from __future__ import annotations

import json
import re
import unicodedata
import urllib.request
from collections.abc import Iterable
from typing import Any

SB_URL = "https://agortpieeygmcttjwjfx.supabase.co"
SB_KEY = "sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P"  # klucz publiczny (anon), jak w aplikacji
MIN_PARSES = 50  # poniżej tego progu nie trenujemy – za mało, żeby zmierzyć efekt
NGRAM = 8

NOMINAL = {"NOUN", "PROPN", "PRON", "NUM", "X"}


def fetch(limit: int = 5000) -> list[dict[str, Any]]:
    req = urllib.request.Request(  # noqa: S310
        f"{SB_URL}/rest/v1/rpc/myc_parse_train",
        data=json.dumps({"p_limit": limit}).encode(),
        headers={"apikey": SB_KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 – stały adres https
        return json.loads(r.read())


def norm(s: str) -> str:
    s = unicodedata.normalize("NFC", s).lower()
    return " ".join(re.findall(r"\w+", s))


def ngrams(words: list[str], n: int = NGRAM) -> set[tuple[str, ...]]:
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


class Guard:
    """Odrzuca zdania z UD dev/test (dokładnie albo przez wspólny 8-gram)."""

    def __init__(self, held_out: Iterable[dict[str, Any]]):
        self.exact: set[str] = set()
        self.grams: set[tuple[str, ...]] = set()
        for s in held_out:
            w = norm(" ".join(t["form"] for t in s["toks"])).split()
            self.exact.add(" ".join(w))
            self.grams |= ngrams(w)

    def leaks(self, sentence: str) -> bool:
        w = norm(sentence).split()
        return " ".join(w) in self.exact or bool(ngrams(w) & self.grams)


def _rel_for(part: str, upos: str | None, has_case: bool) -> str | None:
    if part == "podmiot":
        return "nsubj"
    if part == "dopełnienie":
        return "obl:arg" if has_case else ("obj" if upos in NOMINAL else None)
    if part == "okolicznik":
        return "obl" if upos in NOMINAL else ("advmod" if upos == "ADV" else None)
    if part == "przydawka":
        return "amod" if upos == "ADJ" else ("nmod" if upos in NOMINAL else ("det" if upos == "DET" else None))
    if part == "interpunkcja":
        return "punct"
    if part == "przyimek":
        return "case"
    return None  # orzeczenie, spójnik itd. – relacja zależy od kontekstu, nie zgadujemy


def to_sentence(row: dict[str, Any], tb: str = "pdb") -> dict[str, Any] | None:
    toks = row.get("toks") or []
    if not toks:
        return None
    n = len(toks)
    out = []
    for t in toks:
        try:
            h = int(t.get("head"))
        except (TypeError, ValueError):
            return None
        if not 0 <= h <= n:
            return None
        out.append(
            {
                "form": t["form"],
                "lemma": None,
                "upos": None,
                "feats": None,
                "head": h,
                "deprel": t.get("deprel") or None,
            }
        )
    if row.get("status") == "corrected":
        corr = row.get("correction") or []
        for c in corr:
            i = int(c.get("i", 0))
            if not 1 <= i <= n:
                continue
            t, src = out[i - 1], toks[i - 1]
            if c.get("upos"):
                t["upos"] = c["upos"]
            if c.get("head") is not None and 0 <= int(c["head"]) <= n:
                t["head"] = int(c["head"])
            if c.get("part") and c["part"] != src.get("part"):
                has_case = any(int(o.get("head") or -1) == i and o.get("deprel") == "case" for o in toks)
                t["deprel"] = _rel_for(c["part"], t["upos"] or src.get("upos"), has_case)
    elif row.get("status") != "confirmed":
        return None
    roots = sum(1 for t in out if t["head"] == 0)
    if roots != 1:
        return None
    return {"id": f"glos-{row['id']}", "tb": tb, "src": "weryfikuj", "toks": out}


def build(rows: list[dict[str, Any]], guard: Guard) -> tuple[list[dict[str, Any]], dict[str, int]]:
    stats = {"rows": len(rows), "leak": 0, "invalid": 0, "used": 0}
    seen: set[str] = set()
    out = []
    for r in rows:
        k = norm(r.get("sentence", ""))
        if k in seen:
            continue
        seen.add(k)
        if guard.leaks(r.get("sentence", "")):
            stats["leak"] += 1
            continue
        s = to_sentence(r)
        if s is None:
            stats["invalid"] += 1
            continue
        out.append(s)
    stats["used"] = len(out)
    return out, stats
