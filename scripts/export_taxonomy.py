"""Dane wejściowe samoorganizującej się taksonomii słów (węzły grupują słowa same, bez etykiet).

Wejście (te same słowa co ``web/public/data/lexicon.json`` i ``ml/words_index.bin``):
* osadzenie słowa: wielojęzyczny MiniLM-L12 (384, int8) – policzone wcześniej przez węzeł nasienny,
* sygnał hiperonimów: najbliższe hiperonimy (1–2 poziomy w górę) z Open English WordNet 2025, dla słów
  polskich przez plWordNet (OMW) → ILI → OEWN. Synsety 31 kategorii złotego zbioru są POMINIĘTE,
  żeby grupowanie nie dostało etykiet wprost (złote kategorie służą tylko do oceny).

Wynik: ``web/public/data/taxo/{emb.bin, inputs.json, meta.json}`` (sumy SHA-256 w meta.json).
Stały zbiór oceny: co piąte słowo w kolejności skrótu sha1(język:słowo) – odcisk sha256 w meta.json.

    python scripts/export_taxonomy.py
"""

from __future__ import annotations

import gzip
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from export_lexicon import LEX, MAX_SENSES, TAXONOMY  # noqa: E402

OUT = ROOT / "web" / "public" / "data" / "taxo"
DATA = ROOT / "web" / "public" / "data"


def load_oewn():
    words: dict[str, list[str]] = {}
    hyper: dict[str, list[str]] = {}
    ili: dict[str, str] = {}
    name: dict[str, str] = {}
    with gzip.open(LEX / "english-wordnet-2025.xml.gz") as fh:  # zaufany plik: oficjalne wydanie OEWN 2025
        for _, el in ET.iterparse(fh, events=("end",)):  # noqa: S314
            if el.tag == "LexicalEntry":
                lem = el.find("Lemma")
                if lem.get("partOfSpeech") == "n":
                    for s in el.findall("Sense"):
                        words.setdefault(lem.get("writtenForm"), []).append(s.get("synset"))
                        name.setdefault(s.get("synset"), lem.get("writtenForm"))
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
    return words, hyper, ili, name


def main() -> None:
    lex = json.loads((DATA / "lexicon.json").read_text())
    lw = [x for x in lex["words"] if x[2]]
    raw = np.fromfile(DATA / "ml" / "words_index.bin", np.uint8).reshape(-1, 385)
    assert len(raw) == len(lw), (len(raw), len(lw))
    emb, leaf = raw[:, :384].copy(), raw[:, 384].astype(int)

    words, hyper, ili, name = load_oewn()
    pwn2ili = dict(line.rstrip("\n").split("\t")[::-1] for line in (LEX / "ili-map-pwn30.tab").open())
    ili2sid = {v: k for k, v in ili.items() if v}
    pwn2sid = {p: ili2sid[i] for p, i in pwn2ili.items() if i in ili2sid}
    sid2pwn = {s: p for p, s in pwn2sid.items()}
    anchors = {pwn2sid[f"{off}-n"] for _c, _p, off, *_ in TAXONOMY}
    pl_by_pwn: dict[str, list[str]] = defaultdict(list)
    pl_senses: dict[str, list[str]] = defaultdict(list)
    for line in (LEX / "wn-data-pol.tab").open():
        if line.startswith("#"):
            continue
        p, kind, lem = line.rstrip("\n").split("\t")[:3]
        if kind == "pol:lemma" and p.endswith("-n"):
            pl_by_pwn[p].append(lem)
            if p in pwn2sid:
                pl_senses[lem.lower()].append(pwn2sid[p])
    en_senses: dict[str, list[str]] = defaultdict(list)
    for lemma, sids in words.items():
        en_senses[lemma.lower()].extend(sids)

    def ups(sid: str) -> list[str]:
        out, lvl = [], [sid]
        for _ in range(2):  # 1–2 poziomy w górę
            lvl = [h for s in lvl for h in hyper.get(s, [])]
            out += [h for h in lvl if h not in anchors]
        return out

    per_word: list[list[str]] = []
    for w, lang, _c in lw:
        sids = (en_senses if lang == "en" else pl_senses).get(w, [])[:MAX_SENSES]
        hs: list[str] = []
        for s in sids:
            for h in ups(s):
                if h not in hs:
                    hs.append(h)
        per_word.append(hs)
    df = Counter(h for hs in per_word for h in hs)
    vocab = sorted((h for h, n in df.items() if n >= 3), key=lambda h: (-df[h], h))
    vid = {h: i for i, h in enumerate(vocab)}

    def pl_name(sid: str) -> str:
        lems = pl_by_pwn.get(sid2pwn.get(sid, ""), [])
        return lems[0] if lems else ""

    names = [[name.get(h, h), pl_name(h)] for h in vocab]
    ptr, idx = [0], []
    for hs in per_word:
        idx += [vid[h] for h in hs if h in vid]
        ptr.append(len(idx))
    # stały zbiór oceny: co piąte słowo po skrócie sha1
    order = sorted(
        range(len(lw)), key=lambda i: hashlib.sha1(f"{lw[i][1]}:{lw[i][0]}".encode(), usedforsecurity=False).hexdigest()
    )
    ev = sorted(order[::5])
    tax = lex["taxonomy"]
    inputs = {
        "version": 1,
        "words": [[w, lang] for w, lang, _ in lw],
        "gold": leaf.tolist(),
        "taxonomy": [{"id": c["id"], "parent": c["parent"], "pl": c["pl"], "en": c["en"]} for c in tax],
        "hyper": {"names": names, "ptr": ptr, "idx": idx},
        "eval": ev,
        "sources": [
            "Open English WordNet 2025 (CC-BY-4.0)",
            "plWordNet via OMW (plWordNet licence)",
            "CILI (CC-BY-4.0)",
            "MiniLM-L12 multilingual (Apache-2.0)",
        ],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "emb.bin").write_bytes(emb.tobytes())
    ib = json.dumps(inputs, ensure_ascii=False, separators=(",", ":")).encode()
    (OUT / "inputs.json").write_bytes(ib)
    ev_sha = hashlib.sha256(",".join(f"{lw[i][1]}:{lw[i][0]}:{leaf[i]}" for i in ev).encode()).hexdigest()
    meta = {
        "n": len(lw),
        "dim": 384,
        "emb": {"model": "Xenova/paraphrase-multilingual-MiniLM-L12-v2", "scale": 2.5, "dtype": "int8"},
        "hyper": len(vocab),
        "files": {
            "emb.bin": hashlib.sha256(emb.tobytes()).hexdigest(),
            "inputs.json": hashlib.sha256(ib).hexdigest(),
        },
        "eval_n": len(ev),
        "eval_sha": ev_sha,
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    cover = sum(1 for hs in per_word if any(h in vid for h in hs))
    print(f"{len(lw)} słów, {len(vocab)} hiperonimów (df≥3), z sygnałem: {cover}, ocena: {len(ev)} ({ev_sha[:12]})")


if __name__ == "__main__":
    main()
