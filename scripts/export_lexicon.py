"""Słowniki i taksonomia do klasyfikacji słów (frontend + gold do bazy).

Źródła (licencje w licenses.json):
* Open English WordNet 2025 (CC-BY-4.0) – drzewo hiperonimów = zawężanie kategorii,
* plWordNet przez Open Multilingual Wordnet (licencja plWordNet, typu WordNet – dozwolone),
* CILI (CC-BY-4.0) – mapowanie PWN 3.0 ↔ ILI ↔ OEWN,
* VADER (MIT) – wydźwięk słów angielskich.

Wynik: ``web/public/data/lexicon.json`` (słowa treningowe + taksonomia + pytania bez odpowiedzi)
oraz ``.gold/lexicon.json`` (odpowiedzi kontrolne dla słów z puli pytań – poza repo, do bazy przez
``scripts/gold_rotate.py``; pula z tajnego ``MYC_GOLD_SEED``, scripts/goldkit.py).
"""

from __future__ import annotations

import gzip
import json
import random
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import goldkit  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
LEX = Path.home() / ".cache" / "iot-mycelium" / "lex"

# (id, rodzic, offset PWN 3.0, PL, EN)
TAXONOMY = [
    ("animal", None, "00015388", "Zwierzę", "Animal"),
    ("mammal", "animal", "01861778", "Ssak", "Mammal"),
    ("dog", "mammal", "02084071", "Pies", "Dog"),
    ("feline", "mammal", "02120997", "Kotowate", "Cat family"),
    ("rodent", "mammal", "02329401", "Gryzoń", "Rodent"),
    ("ungulate", "mammal", "02370806", "Kopytne", "Hoofed mammal"),
    ("primate", "mammal", "02469914", "Naczelne", "Primate"),
    ("bird", "animal", "01503061", "Ptak", "Bird"),
    ("fish", "animal", "02512053", "Ryba", "Fish"),
    ("insect", "animal", "02159955", "Owad", "Insect"),
    ("reptile", "animal", "01661091", "Gad", "Reptile"),
    ("amphibian", "animal", "01627424", "Płaz", "Amphibian"),
    ("plant", None, "00017222", "Roślina", "Plant"),
    ("tree", "plant", "13104059", "Drzewo", "Tree"),
    ("flower", "plant", "11669921", "Kwiat", "Flower"),
    ("herb", "plant", "12205694", "Roślina zielna", "Herb"),
    ("food", None, "00021265", "Jedzenie i picie", "Food & drink"),
    ("fruit", "food", "07705931", "Owoc", "Fruit"),
    ("vegetable", "food", "07707451", "Warzywo", "Vegetable"),
    ("beverage", "food", "07881800", "Napój", "Beverage"),
    ("grain", "food", "07802417", "Zboże", "Grain"),
    ("vehicle", None, "04524313", "Pojazd", "Vehicle"),
    ("car", "vehicle", "02958343", "Samochód", "Car"),
    ("vessel", "vehicle", "04530566", "Jednostka pływająca", "Watercraft"),
    ("aircraft", "vehicle", "02686568", "Statek powietrzny", "Aircraft"),
    ("tool", None, "04451818", "Narzędzie", "Tool"),
    ("instrument", None, "03800933", "Instrument muzyczny", "Musical instrument"),
    ("furniture", None, "03405725", "Mebel", "Furniture"),
    ("clothing", None, "03051540", "Ubranie", "Clothing"),
    ("person", None, "00007846", "Osoba", "Person"),
    ("worker", "person", "09632518", "Zawód / pracownik", "Worker / occupation"),
]
MAX_SENSES = 2  # tylko najczęstsze znaczenia słowa (kolejność sensów WordNetu)


CORRECTIONS: dict[tuple[str, str], set[str]] = {
    ("en", "hedgehog"): {"mammal"},
    ("pl", "jeż"): {"mammal"},
}


def load_oewn():
    words: dict[str, list[str]] = {}  # lemat -> synsety w kolejności sensów
    hyper: dict[str, list[str]] = {}
    ili: dict[str, str] = {}
    # zaufany plik: oficjalne wydanie OEWN 2025 pobrane do lokalnej pamięci podręcznej
    with gzip.open(LEX / "english-wordnet-2025.xml.gz") as fh:
        for _, el in ET.iterparse(fh, events=("end",)):  # noqa: S314
            if el.tag == "LexicalEntry":
                lem = el.find("Lemma")
                if lem.get("partOfSpeech") == "n":
                    words.setdefault(lem.get("writtenForm"), []).extend(s.get("synset") for s in el.findall("Sense"))
                el.clear()
            elif el.tag == "Synset":
                if el.get("partOfSpeech") == "n":
                    sid = el.get("id")
                    ili[sid] = el.get("ili") or ""
                    hyper[sid] = [
                        r.get("target")
                        for r in el.findall("SynsetRelation")
                        if r.get("relType") in ("hypernym", "instance_hypernym")
                    ]
                el.clear()
    return words, hyper, ili


def main() -> None:
    words, hyper, ili = load_oewn()
    pwn2ili = dict(line.rstrip("\n").split("\t")[::-1] for line in (LEX / "ili-map-pwn30.tab").open())
    ili2sid = {v: k for k, v in ili.items() if v}
    sid2pwn = {ili2sid[i]: p for p, i in pwn2ili.items() if i in ili2sid}
    cat_sid = {}
    for cid, _, off, *_ in TAXONOMY:
        sid = ili2sid.get(pwn2ili.get(f"{off}-n", ""))
        assert sid, cid
        cat_sid[sid] = cid
    parent = {c[0]: c[1] for c in TAXONOMY}

    memo: dict[str, frozenset[str]] = {}

    def cats(sid: str, depth: int = 0) -> frozenset[str]:
        if sid in memo:
            return memo[sid]
        out = {cat_sid[sid]} if sid in cat_sid else set()
        if depth < 40:
            for h in hyper.get(sid, []):
                out |= cats(h, depth + 1)
        memo[sid] = frozenset(out)
        return memo[sid]

    def close(cs: set[str]) -> list[str]:
        full = set(cs)
        for c in cs:
            p = parent[c]
            while p:
                full.add(p)
                p = parent[p]
        order = [c[0] for c in TAXONOMY]
        return sorted(full, key=order.index)

    entries: dict[tuple[str, str], set[str]] = defaultdict(set)
    for lemma, sids in words.items():
        w = lemma.lower()
        if not w.isalpha() or not 2 < len(w) <= 14:
            continue
        for sid in sids[:MAX_SENSES]:
            entries[("en", w)] |= cats(sid)
    # polskie lematy (plWordNet przez OMW, klucz PWN 3.0)
    pl_by_pwn: dict[str, list[str]] = defaultdict(list)
    for line in (LEX / "wn-data-pol.tab").open():
        if line.startswith("#"):
            continue
        p, kind, lem = line.rstrip("\n").split("\t")[:3]
        if kind == "pol:lemma" and p.endswith("-n"):
            pl_by_pwn[p].append(lem)
    for sid, p in sid2pwn.items():
        for lem in pl_by_pwn.get(p, [])[:3]:
            w = lem.lower()
            if (
                w.replace("ą", "a")
                .replace("ę", "e")
                .replace("ó", "o")
                .replace("ś", "s")
                .replace("ł", "l")
                .replace("ż", "z")
                .replace("ź", "z")
                .replace("ć", "c")
                .replace("ń", "n")
                .isalpha()
                and 2 < len(w) <= 14
            ):
                entries[("pl", w)] |= cats(sid)

    # ręczne poprawki błędów WordNetu (np. „hedgehog” ma też sens „porcupine” → Gryzoń; jeż to owadożerny ssak, nie gryzoń)
    for key, cs in CORRECTIONS.items():
        entries[key] = set(cs)
    items = [(lang, w, close(cs)) for (lang, w), cs in entries.items() if cs]
    rng = random.Random(7)
    rng.shuffle(items)
    # zbalansowanie: max 450 słów na kategorię-liść w każdym języku
    cap: dict[tuple[str, str], int] = defaultdict(int)
    kept = []
    for lang, w, path in items:
        leaf = path[-1]
        if cap[(lang, leaf)] < 450:
            cap[(lang, leaf)] += 1
            kept.append((lang, w, path))
    # Podział treningowy z jawnym ziarnem 7 (bez zmian od rundy 1 – zbiory oceny modeli zostają te same).
    pool1 = [x for x in kept if x[0] == "en"][:150] + [x for x in kept if x[0] == "pl"][:150]
    pool_set = {(lang, w) for lang, w, _ in pool1}
    train = [x for x in kept if (x[0], x[1]) not in pool_set]
    # Pula pytań kontrolnych (runda ≥ 2): tajne ziarno, tylko słowa spoza treningu i spoza jawnej puli rundy 1
    # (nadmiar ponad limit 450 na kategorię) – stare, ujawnione odpowiedzi nie pasują do żadnego nowego pytania.
    kept_set = {(lang, w) for lang, w, _ in kept}
    spare = sorted(x for x in items if (x[0], x[1]) not in kept_set)
    grng = random.Random(goldkit.seed("lexicon"))
    grng.shuffle(spare)
    pool = [x for x in spare if x[0] == "en"][:150] + [x for x in spare if x[0] == "pl"][:150]
    cat_ids = [c[0] for c in TAXONOMY]

    vader = {}
    for line in (LEX / "vader_lexicon.txt").open(encoding="utf-8", errors="ignore"):
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0].isalpha():
            vader[parts[0]] = round(float(parts[1]), 1)

    questions = [{"id": goldkit.rid("w", i, 5), "word": w, "lang": lang} for i, (lang, w, _) in enumerate(pool)]
    gold_rows = []
    for i, (_, _, path) in enumerate(pool):
        for j, c in enumerate(cat_ids):
            gold_rows.append((f"{goldkit.rid('w', i, 5)}c{j:03d}", "tak" if c in path else "nie"))
    out = {
        "version": 1,
        "taxonomy": [{"id": c[0], "parent": c[1], "pl": c[3], "en": c[4]} for c in TAXONOMY],
        "words": [[w, lang, [cat_ids.index(c) for c in path]] for lang, w, path in train],
        "questions": questions,
        "sentiment": vader,
        "sources": [
            "Open English WordNet 2025 (CC-BY-4.0)",
            "plWordNet via OMW (plWordNet licence)",
            "CILI (CC-BY-4.0)",
            "VADER (MIT)",
        ],
    }
    (ROOT / "web" / "public" / "data" / "lexicon.json").write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    )
    goldkit.write("lexicon", gold_rows, "scripts/export_lexicon.py")
    by_lang = defaultdict(int)
    for lang, *_ in train:
        by_lang[lang] += 1
    print(
        f"słowa treningowe {dict(by_lang)}, pytania {len(questions)}, kategorie {len(cat_ids)}, VADER {len(vader)}, rozmiar {(ROOT / 'web/public/data/lexicon.json').stat().st_size // 1024} KB"
    )


if __name__ == "__main__":
    main()
