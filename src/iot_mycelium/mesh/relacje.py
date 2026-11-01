"""Pytania o relacje dla czystej grzybni (dom, młode, narzędzie, przeciwieństwo, część, produkt).

Samouk proponuje pytania – nigdy odpowiedzi. Odpowiedź człowiek pisze pełnym zdaniem w zakładce Czysta grzybnia,
zdanie przechodzi przez Weryfikuj (konsensus) i dopiero wtedy czysty rozumujący może go użyć w analogii.
Szablony pytań są te same co w ``supabase/myc_rel.sql`` (``myc_rel_question_text``) i
``web/src/myc/czystaRelacje.ts`` – zgodność sprawdza ``web/scripts/czysta-check.mjs``.
"""

from __future__ import annotations

import random

from . import selfplay

KINDS: dict[str, str] = {
    "dom": "Gdzie mieszka {w}?",
    "młode": "Jak nazywa się młode zwierzęcia „{w}”?",
    "narzędzie": "Czego używa {w} w pracy?",
    "przeciwieństwo": "Co jest przeciwieństwem słowa „{w}”?",
    "część": "Czego częścią jest {w}?",
    "produkt": "Co daje {w}?",
}


def question(kind: str, word: str) -> str:
    return KINDS[kind].format(w=word)


def samouk_proposals(seed: int, n: int = 6, known: set[tuple[str, str]] | None = None) -> list[dict]:
    """Pytania o relacje ze słów ćwiczeń analogii samouka (selfplay, nowe ziarno).

    Z ćwiczenia „A : B = C : ?” bierze tylko rodzaj relacji i słowa A, C (strona pytana) – bez B i bez odpowiedzi.
    """
    known = set(known or ())
    r = random.Random(seed)
    out: list[dict] = []
    for _ in range(200):
        if len(out) >= n:
            break
        t = selfplay.analogy(r, 1)
        head = t.question.split(" Wybierz")[0]
        a, b, c = (x.strip() for x in head.replace("= ", ": ").replace("?", "").split(":")[:3])
        kind = next((k for k, v in selfplay.REL.items() if (a, b) in v), None)
        if kind is None or kind not in KINDS:
            continue
        for w in (a, c):
            if (kind, w) in known or len(out) >= n:
                continue
            known.add((kind, w))
            out.append({
                "kind": kind,
                "word": w,
                "question": question(kind, w),
                "reason": f"samouk: ćwiczenie analogii z relacją „{kind}” (selfplay, ziarno {seed}) – czysta grzybnia odpowie "
                f"tylko z faktu zatwierdzonego przez ludzi, więc pytam o „{w}”",
            })  # fmt: skip
    return out
