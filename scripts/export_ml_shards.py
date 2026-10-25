"""Eksport prawdziwych zbiorów do odłamków binarnych dla rozproszonego treningu w przeglądarkach (web/public/data/ml).

Zbiory: Fashion-MNIST (28×28, CNN), UCI HAR (561 cech, MLP), CLINC150 (intencje, osadzenia zdań MiniLM-L6),
słowniki WordNet/plWordNet (kategoria słowa z osadzeń wielojęzycznego MiniLM-L12). Osadzenia liczy
web/scripts/export-embeddings.mjs (transformers.js, skwantowany ONNX q8 – ten sam co w przeglądarce). Każdy ma odłamki treningowe, walidację
(sprawdzanie zgłoszeń) i odłożony test (dokładność modelu globalnego). Bez danych syntetycznych.

Formaty: dense-u8: [784 px][etykieta]; dense-i8: [561 × int8 (x·127)][etykieta];
sparse: [u16 etykieta][u16 n][n × u16 indeks kubełka] (little-endian).
"""

from __future__ import annotations

import gzip
import json
import os
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DS = Path.home() / ".cache" / "iot-mycelium" / "datasets"
OUT = Path(os.environ.get("MYC_OUT", ROOT / "web" / "public" / "data" / "ml"))
HASH_DIM = {"intent": 2048, "words": 1024}
WORD_TRI = 512
EMB = Path.home() / ".cache" / "iot-mycelium" / "emb"
EMB_SCALE = {"intent": 4.0, "words": 2.5}  # osadzenia (norma 1) × skala → int8/127
EMB_MODEL = {"intent": "Xenova/all-MiniLM-L6-v2", "words": "Xenova/paraphrase-multilingual-MiniLM-L12-v2"}
# Architektury (te same w engine.worker.ts – budowa z meta.json); id zapisuje się w meta wersji modelu globalnego
ARCH = {
    "fashion": {
        "id": "cnn3",
        "layers": [
            {"t": "conv", "f": 32, "same": True, "relu": True},
            {"t": "pool"},
            {"t": "conv", "f": 64, "same": True, "relu": True},
            {"t": "pool"},
            {"t": "conv", "f": 64, "same": True, "relu": True},
            {"t": "pool"},
            {"t": "flatten"},
            {"t": "drop", "r": 0.3},
            {"t": "dense", "u": 128, "relu": True},
            {"t": "drop", "r": 0.3},
            {"t": "dense", "u": 10},
        ],
    },
    "har": {
        "id": "mlp2",
        "layers": [
            {"t": "dense", "u": 256, "relu": True},
            {"t": "drop", "r": 0.3},
            {"t": "dense", "u": 128, "relu": True},
            {"t": "drop", "r": 0.3},
            {"t": "dense", "u": 6},
        ],
    },
    "intent": {
        "id": "minilm-mlp",
        "layers": [{"t": "dense", "u": 256, "relu": True}, {"t": "drop", "r": 0.3}, {"t": "dense", "u": 150}],
    },
    "words": {
        "id": "mminilm-gloss-mlp",
        "layers": [{"t": "dense", "u": 192, "relu": True}, {"t": "drop", "r": 0.3}, {"t": "dense", "u": 31}],
    },
}


def emb_rows(file: str, m: str) -> np.ndarray:
    a = np.fromfile(EMB / f"{file}.f32", np.float32).reshape(-1, 384)
    return np.clip(np.round(a * EMB_SCALE[m] * 127), -127, 127).astype(np.int8).view(np.uint8)


def write_dense(path: Path, rows: list[tuple[int, np.ndarray]]) -> None:
    path.write_bytes(b"".join(x.tobytes() + bytes([y]) for y, x in rows))


def fnv(s: str) -> int:
    h = 2166136261
    for ch in s.encode():
        h = ((h ^ ch) * 16777619) & 0xFFFFFFFF
    return h


def text_feats(text: str, dim: int) -> list[int]:
    toks = "".join(c if c.isalnum() or c == "'" else " " for c in text.lower()).split()
    grams = toks + [f"{a} {b}" for a, b in zip(toks, toks[1:], strict=False)]
    return [fnv(g) % dim for g in grams][:255]


def word_feats(word: str, dim: int) -> list[int]:
    w = f"^{word.lower()}$"
    grams = [w[i : i + 3] for i in range(len(w) - 2)] + [w[i : i + 2] for i in range(len(w) - 1)]
    return [fnv(g) % dim for g in grams][:255]


def write_sparse(path: Path, rows: list[tuple[int, list[int]]]) -> None:
    b = bytearray()
    for y, idx in rows:
        b += struct.pack(f"<HH{len(idx)}H", y, len(idx), *idx)
    path.write_bytes(bytes(b))


def shard(name: str, chunks: list[bytes] | list, per: int, writer) -> int:
    n = 0
    for i in range(0, len(chunks), per):
        writer(OUT / name / f"train-{i // per:02d}.bin", chunks[i : i + per])
        n += 1
    return n


def idx(path: Path) -> np.ndarray:
    with gzip.open(path) as f:
        data = f.read()
    if data[2] == 8 and data[3] == 3:
        return np.frombuffer(data, np.uint8, offset=16).reshape(-1, 784)
    return np.frombuffer(data, np.uint8, offset=8)


FASHION_SHARDS = 60  # cały oficjalny trening (60 000); pierwsze 24 odłamki identyczne jak w wersji 24 000


def main() -> None:
    rng = np.random.default_rng(2026)
    only = os.environ.get("MYC_ONLY")  # np. MYC_ONLY=fashion – przelicz tylko ten zbiór, resztę meta.json zostaw
    meta: dict[str, dict] = json.loads((OUT / "meta.json").read_text()) if only else {}
    # Fashion-MNIST: 60 000 z oficjalnego treningu (ta sama permutacja), walidacja 1 000 i test 2 000 z oficjalnego t10k
    (OUT / "fashion").mkdir(parents=True, exist_ok=True)
    X, y = idx(DS / "train-images-idx3-ubyte.gz"), idx(DS / "train-labels-idx1-ubyte.gz")
    Xt, yt = idx(DS / "t10k-images-idx3-ubyte.gz"), idx(DS / "t10k-labels-idx1-ubyte.gz")
    p = rng.permutation(len(X))[: FASHION_SHARDS * 1000]
    rows = np.concatenate([X[p], y[p, None]], 1)
    for i in range(FASHION_SHARDS):
        (OUT / "fashion" / f"train-{i:02d}.bin").write_bytes(rows[i * 1000 : (i + 1) * 1000].tobytes())
    q = rng.permutation(len(Xt))
    for nm, sl in (("val", q[:1000]), ("test", q[1000:3000])):
        (OUT / "fashion" / f"{nm}.bin").write_bytes(np.concatenate([Xt[sl], yt[sl, None]], 1).tobytes())
    meta["fashion"] = {
        "format": "dense-u8",
        "dim": 784,
        "shape": [28, 28, 1],
        "classes": 10,
        "shards": FASHION_SHARDS,
        "per_shard": 1000,
        "val": 1000,
        "test": 2000,
        "source": "Fashion-MNIST (Zalando, MIT)",
        "arch": ARCH["fashion"],
        "augment": True,
    }
    if only == "fashion":
        (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
        print(f"fashion: {FASHION_SHARDS} odłamków")
        return
    # UCI HAR: oficjalny podział (osoby treningowe / testowe)
    har = DS / "UCI HAR Dataset"
    (OUT / "har").mkdir(parents=True, exist_ok=True)
    Xh = np.loadtxt(har / "train" / "X_train.txt", dtype=np.float32)
    yh = np.loadtxt(har / "train" / "y_train.txt", dtype=np.int64) - 1
    Xht = np.loadtxt(har / "test" / "X_test.txt", dtype=np.float32)
    yht = np.loadtxt(har / "test" / "y_test.txt", dtype=np.int64) - 1

    def enc(A, b):
        return np.concatenate(
            [np.clip(np.round(A * 127), -127, 127).astype(np.int8).view(np.uint8), b[:, None].astype(np.uint8)], 1
        )

    p = rng.permutation(len(Xh))
    rh = enc(Xh[p], yh[p])
    ns = len(rh) // 500
    for i in range(ns):
        (OUT / "har" / f"train-{i:02d}.bin").write_bytes(
            rh[i * 500 : (i + 1) * 500 if i < ns - 1 else len(rh)].tobytes()
        )
    q = rng.permutation(len(Xht))
    (OUT / "har" / "val.bin").write_bytes(enc(Xht[q[:700]], yht[q[:700]]).tobytes())
    (OUT / "har" / "test.bin").write_bytes(enc(Xht[q[700:]], yht[q[700:]]).tobytes())
    meta["har"] = {
        "format": "dense-i8",
        "dim": 561,
        "classes": 6,
        "shards": ns,
        "val": 700,
        "test": int(len(q) - 700),
        "source": "UCI HAR (CC BY 4.0)",
        "arch": ARCH["har"],
    }
    # CLINC150: trening + oficjalna walidacja do odłamków, oficjalny test → walidacja 1 000 / test 3 500
    d = json.loads((DS / "data_small.json").read_text())
    intents = sorted({lab for _, lab in d["train"]})
    lab = {k: i for i, k in enumerate(intents)}
    (OUT / "intent").mkdir(parents=True, exist_ok=True)
    etr, ete = emb_rows("intent_train", "intent"), emb_rows("intent_test", "intent")
    tr = [(lab[c], etr[i]) for i, (_t, c) in enumerate(d["train"] + d["val"])]
    tr = [tr[i] for i in rng.permutation(len(tr))]
    ns = shard("intent", tr, 700, write_dense)
    te = [(lab[c], ete[i]) for i, (_t, c) in enumerate(d["test"])]
    te = [te[i] for i in rng.permutation(len(te))]
    write_dense(OUT / "intent" / "val.bin", te[:1000])
    write_dense(OUT / "intent" / "test.bin", te[1000:])
    meta["intent"] = {
        "format": "dense-i8",
        "dim": 384,
        "emb": {"model": EMB_MODEL["intent"], "scale": EMB_SCALE["intent"], "pooling": "mean", "dtype": "q8"},
        "arch": ARCH["intent"],
        "classes": len(intents),
        "shards": ns,
        "val": 1000,
        "test": len(te) - 1000,
        "labels": intents,
        "source": "CLINC150 (CC BY 3.0)",
    }
    # Słowniki: kategoria słowa (pierwsza etykieta) z trigramów znaków
    lex = json.loads((ROOT / "web" / "public" / "data" / "lexicon.json").read_text())
    (OUT / "words").mkdir(parents=True, exist_ok=True)
    # cechy słowa: osadzenie wielojęzyczne (384) + haszowane trigramy znaków (512, 0/1) + język (en/pl)
    ew = emb_rows("words", "words")
    lw = [x for x in lex["words"] if x[2]]
    tri = np.zeros((len(lw), WORD_TRI + 2), np.int8)
    for i, (w, lang, _c) in enumerate(lw):
        tri[i, word_feats(w, WORD_TRI)] = 127
        tri[i, WORD_TRI + (lang == "pl")] = 127
    # + osadzenie definicji z Wikisłownika (384; niezależne od WordNetu, więc bez przecieku etykiety)
    eg = emb_rows("words_gloss", "words")
    ew = np.concatenate([ew, eg, tri.view(np.uint8)], 1)
    # indeks sąsiadów dla przeglądarki (kNN po osadzeniu słowa): [384 × int8][liść u8], kolejność jak w lexicon.json
    tax = lex["taxonomy"]
    par = {c["id"]: c["parent"] for c in tax}
    pos = {c["id"]: i for i, c in enumerate(tax)}

    def depth(i: int) -> int:
        d, p = 1, par[tax[i]["id"]]
        while p:
            d, p = d + 1, par[p]
        return d

    leaf = np.array([max(cats, key=depth) for _w, _l, cats in lw], np.uint8)
    assert len(pos) < 256
    (OUT / "words_index.bin").write_bytes(np.concatenate([ew[:, :384], leaf[:, None]], 1).tobytes())
    ws = [(cats[0], ew[i]) for i, (_w, _lang, cats) in enumerate(lw)]
    ws = [ws[i] for i in rng.permutation(len(ws))]
    nv = len(ws) // 10
    ns = shard("words", ws[2 * nv :], 800, write_dense)
    write_dense(OUT / "words" / "val.bin", ws[:nv])
    write_dense(OUT / "words" / "test.bin", ws[nv : 2 * nv])
    meta["words"] = {
        "format": "dense-i8",
        "dim": 384 + 384 + WORD_TRI + 2,
        "emb": {
            "model": EMB_MODEL["words"],
            "scale": EMB_SCALE["words"],
            "pooling": "mean",
            "dtype": "q8",
            "gloss": "en.wiktionary.org (CC BY-SA)",
            "trigrams": WORD_TRI,
            "lang": ["en", "pl"],
        },
        "arch": ARCH["words"],
        "classes": len(lex["taxonomy"]),
        "shards": ns,
        "val": nv,
        "test": nv,
        "source": "Open English WordNet + plWordNet (słowniki grzybni)",
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    total = sum(f.stat().st_size for f in OUT.rglob("*.bin"))
    print({k: (v["shards"], v["classes"]) for k, v in meta.items()}, f"{total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
