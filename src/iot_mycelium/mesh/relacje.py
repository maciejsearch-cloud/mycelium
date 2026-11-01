"""Pytania o relacje dla czystej grzybni (dom, młode, narzędzie, przeciwieństwo, część, produkt).

Samouk proponuje pytania – nigdy odpowiedzi. Odpowiedź człowiek pisze pełnym zdaniem w zakładce Czysta grzybnia,
zdanie przechodzi przez Weryfikuj (konsensus) i dopiero wtedy czysty rozumujący może go użyć w analogii.

Słowa pytań pochodzą z prawdziwych źródeł spoza testu: (1) słownictwo zatwierdzone w czacie i Weryfikuj
(myc_meanings, strzępki od ludzi), (2) listy ze słownika Morfeusza 2 / SGJP (``web/public/data/rozbior/morf.json.gz``). Słowa
z testów analogii (``selfplay.REL`` i pytania analogii w zamrożonych zestawach ``results/czysta/parafrazy-*.json``)
i wszystkie ich formy są wykluczone – ``banned_forms`` (ta sama lista w ``supabase/myc_rel_banned.sql``).

Szablony pytań są te same co w ``supabase/myc_rel.sql`` (``myc_rel_question_text``) i
``web/src/myc/czystaRelacje.ts`` – zgodność sprawdza ``web/scripts/czysta-check.mjs``.
"""

from __future__ import annotations

import gzip
import json
import random
import re
from functools import lru_cache
from pathlib import Path

from . import selfplay

ROOT = Path(__file__).resolve().parents[3]
LEX = ROOT / "web" / "public" / "data" / "rozbior" / "morf.json.gz"

KINDS: dict[str, str] = {
    "dom": "Gdzie mieszka {w}?",
    "młode": "Jak nazywa się młode zwierzęcia „{w}”?",
    "narzędzie": "Czego używa {w} w pracy?",
    "przeciwieństwo": "Co jest przeciwieństwem słowa „{w}”?",
    "część": "Czego częścią jest {w}?",
    "produkt": "Co daje {w}?",
}
# zawody (m1) po przyrostku: piekarz, ogrodnik, krawiec, dentysta, aktor, fryzjer
PROFESSION = re.compile(r"(arz|nik|iec|ista|ysta|or|er|ent|og)$")


def question(kind: str, word: str) -> str:
    return KINDS[kind].format(w=word)


def test_words() -> set[str]:
    """Słowa testów analogii: tabela ćwiczeń i pytania analogii w zamrożonych zestawach (z opcjami)."""
    out = {w for v in selfplay.REL.values() for pair in v for w in pair}
    for f in sorted((ROOT / "results" / "czysta").glob("parafrazy-*.json")):
        for it in json.loads(f.read_text())["items"]:
            if it.get("kind") == "analogia":
                out |= {
                    w.lower()
                    for w in re.findall(r"\w+", it["q"], re.U)
                    if w.lower() not in {"wybierz", "jedno", "słowo"}
                }
                out.add(it["a"].lower())
    return out


@lru_cache(maxsize=1)
def _lex() -> list[tuple[str, str, list[str]]]:
    """(forma, lemat, tag) ze słownika Morfeusza 2 / SGJP (ten sam co w przeglądarce)."""
    d = json.loads(gzip.decompress(LEX.read_bytes()))
    rules, tags = d["rules"], d["tags"]
    out = []
    for form, an in d["forms"].items():
        for r, ti in an:
            cut, add, _ = (rules[r].split("|") + ["", ""])[:3]
            lemma = (form[: len(form) - int(cut)] if int(cut) else form) + add
            out.append((form, lemma, tags[ti].split(":")))
    return out


@lru_cache(maxsize=1)
def banned_forms() -> frozenset[str]:
    """Słowa testów i wszystkie ich formy ze słownika (żeby „norze” było tak samo zakazane jak „nora”)."""
    tw = test_words()
    return frozenset(tw | {f.lower() for f, lem, _ in _lex() if lem.lower() in tw})


def mentions_test_word(text: str) -> bool:
    return any(w in banned_forms() for w in re.findall(r"\w+", text.lower(), re.U))


def classify(word: str) -> list[str]:
    """Rodzaje relacji pasujące do słowa wg znacznika Morfeusza (forma podstawowa = lemat)."""
    kinds: list[str] = []
    for f, lem, t in _lex():
        if f != word or lem != word:
            continue
        if t[0] == "subst" and t[1:3] == ["sg", "nom"]:
            if t[3] == "m2":
                kinds += ["dom", "młode"]  # rodzaj męskozwierzęcy – zwierzęta
            if t[3] == "m1" and PROFESSION.search(word):
                kinds.append("narzędzie")
        if t[0] == "adj" and t[1:3] == ["sg", "nom"] and t[3].startswith("m1") and t[-1] == "pos":
            kinds.append("przeciwieństwo")
    return sorted(set(kinds))


@lru_cache(maxsize=1)
def gradable() -> frozenset[str]:
    """Przymiotniki stopniowalne (słownik zna stopień wyższy) – takie zwykle mają przeciwieństwo (wysoki/niski)."""
    return frozenset(lem for _, lem, t in _lex() if t[0] == "adj" and t[-1] == "com")


def lexicon_candidates() -> list[tuple[str, str]]:
    """Ze słownika: przymiotniki stopniowalne (przeciwieństwo) i zawody (narzędzie); bez liczb i skrótów."""
    out = set()
    grad = gradable()
    for f, lem, t in _lex():
        if f != lem or not re.fullmatch(r"[a-ząćęłńóśźż]{4,}", f):
            continue
        if t[0] == "adj" and t[1:3] == ["sg", "nom"] and t[3].startswith("m1") and t[-1] == "pos" and f in grad:
            out.add(("przeciwieństwo", f))
        if t[0] == "subst" and t[1:4] == ["sg", "nom", "m1"] and PROFESSION.search(f) and len(f) >= 6:
            out.add(("narzędzie", f))
    return sorted(out)


def samouk_proposals(
    seed: int, n: int = 6, known: set[tuple[str, str]] | None = None, vocab: list[str] | None = None
) -> list[dict]:
    """Pytania o relacje: najpierw słownictwo zatwierdzone przez ludzi, potem listy ze słownika. Bez słów testu."""
    known = set(known or ())
    r = random.Random(seed)
    out: list[dict] = []

    def add(kind: str, w: str, why: str) -> None:
        if len(out) < n and (kind, w) not in known and not mentions_test_word(w):
            known.add((kind, w))
            out.append({"kind": kind, "word": w, "question": question(kind, w), "reason": why})

    for w in sorted({v.lower().strip() for v in vocab or [] if re.fullmatch(r"[a-ząćęłńóśźż]{3,}", v.lower().strip())}):
        for k in classify(w):
            add(
                k,
                w,
                f"samouk: słowo „{w}” z wiedzy zatwierdzonej w czacie/Weryfikuj; słownik Morfeusza: pasuje do relacji „{k}”",
            )
    cands = lexicon_candidates()
    r.shuffle(cands)
    for k, w in cands:
        add(
            k,
            w,
            f"samouk: {'przymiotnik stopniowalny' if k == 'przeciwieństwo' else 'zawód'} ze słownika Morfeusza 2 / SGJP",
        )
    return out
