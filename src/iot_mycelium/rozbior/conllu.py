"""Czytnik CoNLL-U. Pomija wiersze wielowyrazowe (1-2) i węzły pustych (1.1); zostawia słowa składniowe UD."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field


@dataclass
class Tok:
    form: str
    lemma: str
    upos: str
    feats: dict[str, str]
    head: int  # 0 = korzeń, inaczej 1-based
    deprel: str
    space: bool = True


@dataclass
class Sent:
    sid: str
    text: str
    toks: list[Tok] = field(default_factory=list)


def parse_feats(s: str) -> dict[str, str]:
    if not s or s == "_":
        return {}
    out = {}
    for kv in s.split("|"):
        k, _, v = kv.partition("=")
        out[k] = v
    return out


def read(path: str) -> Iterator[Sent]:
    sid, text, toks = "", "", []
    mwt: dict[int, tuple[int, bool]] = {}  # początek → (koniec, spacja po słowie wielowyrazowym)
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                if toks:
                    yield Sent(sid, text, toks)
                sid, text, toks, mwt = "", "", [], {}
                continue
            if line.startswith("#"):
                if line.startswith("# sent_id"):
                    sid = line.split("=", 1)[1].strip()
                elif line.startswith("# text ="):
                    text = line.split("=", 1)[1].strip()
                continue
            c = line.split("\t")
            if "-" in c[0]:
                a, b = c[0].split("-")
                mwt[int(a)] = (int(b), "SpaceAfter=No" not in (c[9] or ""))
                continue
            if "." in c[0]:
                continue
            i = int(c[0])
            sp = "SpaceAfter=No" not in (c[9] or "")
            for a, (b, msp) in mwt.items():
                if a <= i < b:
                    sp = False
                elif i == b:
                    sp = msp
            toks.append(Tok(c[1], c[2], c[3], parse_feats(c[5]), int(c[6]), c[7], sp))
    if toks:
        yield Sent(sid, text, toks)
