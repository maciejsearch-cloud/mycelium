"""Zadania w stylu captcha – prawdziwe dane do nauki z ludzi (frontend + gold do bazy).

Rodzaje (identyfikatory pytań w ``myc_answers``):
* ``cg?####k#`` – obraz Fashion-MNIST × klasa (tak/nie): siatka obrazków i przeciąganie do koszy,
* ``ct#####``   – litera EMNIST (a–z): przepisywanie odręcznych liter,
* ``cr#####``   – obrót obrazka (zero/prawo/dol/lewo): ustaw prosto,
* ``co#####``   – kolejność 4 wydarzeń historycznych (permutacja liter a–d),
* ``cm#####``   – para PL↔EN z plWordNet/OEWN (tak/nie): dopasuj pary.

Do frontu trafiają obrazy i pytania BEZ odpowiedzi; odpowiedzi kontrolne (gold, ok. 1/3
obrazów i liter – wybór tajny, wszystkie obroty i kolejności, 1/3 par) idą tylko do ``.gold/captcha.json`` (poza repo,
do bazy przez ``scripts/gold_rotate.py``). Od rundy 2 pule pytań losuje tajne ``MYC_GOLD_SEED`` (scripts/goldkit.py)
spośród przykładów spoza zestawów startowych/testowych, odłamków i jawnych pul rundy 1; identyfikatory mają literę
rundy (np. ``cgb0000k3``). Zestawy startowe, testowe i odłamki są bez zmian (jawne ziarno 11).
Zestaw startowy i testowy (z etykietami) służą do trenowania i oceny modeli w przeglądarce.

Licencje: Fashion-MNIST (MIT), EMNIST (CC0 / NIST), OEWN 2025 (CC-BY-4.0), plWordNet (licencja plWordNet).
"""

from __future__ import annotations

import base64
import gzip
import io
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import goldkit  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path.home() / ".cache" / "iot-mycelium"
DS = CACHE / "datasets"
sys.path.insert(0, str(ROOT / "scripts"))

FMNIST_PL = [
    "koszulka",
    "spodnie",
    "sweter",
    "sukienka",
    "płaszcz",
    "sandał",
    "koszula",
    "trampek",
    "torba",
    "but za kostkę",
]
FMNIST_EN = ["T-shirt", "trousers", "pullover", "dress", "coat", "sandal", "shirt", "sneaker", "bag", "ankle boot"]
ROT = ["zero", "prawo", "dol", "lewo"]  # obrót potrzebny, by obraz był prosto (0°, 90° w prawo, 180°, 90° w lewo)

# Prawdziwe daty (rok) – kolejność chronologiczna jest kontrolą uwagi i wiedzy.
EVENTS = [
    (966, "Chrzest Polski", "Baptism of Poland"),
    (1066, "Bitwa pod Hastings", "Battle of Hastings"),
    (1215, "Magna Carta", "Magna Carta"),
    (1410, "Bitwa pod Grunwaldem", "Battle of Grunwald"),
    (1453, "Upadek Konstantynopola", "Fall of Constantinople"),
    (1492, "Kolumb dociera do Ameryki", "Columbus reaches the Americas"),
    (1517, "95 tez Lutra", "Luther's 95 Theses"),
    (1543, "Kopernik: O obrotach sfer niebieskich", "Copernicus: On the Revolutions"),
    (1569, "Unia lubelska", "Union of Lublin"),
    (1648, "Pokój westfalski", "Peace of Westphalia"),
    (1683, "Odsiecz wiedeńska", "Battle of Vienna"),
    (1687, "Newton: Principia", "Newton: Principia"),
    (1776, "Deklaracja niepodległości USA", "US Declaration of Independence"),
    (1789, "Rewolucja francuska", "French Revolution"),
    (1791, "Konstytucja 3 maja", "Constitution of 3 May"),
    (1815, "Bitwa pod Waterloo", "Battle of Waterloo"),
    (1830, "Powstanie listopadowe", "November Uprising"),
    (1848, "Wiosna Ludów", "Spring of Nations"),
    (1859, "Darwin: O powstawaniu gatunków", "Darwin: On the Origin of Species"),
    (1863, "Powstanie styczniowe", "January Uprising"),
    (1903, "Pierwszy lot braci Wright", "Wright brothers' first flight"),
    (1912, "Zatonięcie Titanica", "Sinking of the Titanic"),
    (1914, "Wybuch I wojny światowej", "Outbreak of World War I"),
    (1918, "Polska odzyskuje niepodległość", "Poland regains independence"),
    (1920, "Bitwa Warszawska", "Battle of Warsaw"),
    (1939, "Wybuch II wojny światowej", "Outbreak of World War II"),
    (1944, "Powstanie warszawskie", "Warsaw Uprising"),
    (1957, "Sputnik 1 na orbicie", "Sputnik 1 in orbit"),
    (1969, "Lądowanie na Księżycu", "Moon landing"),
    (1980, "Powstanie Solidarności", "Solidarity is founded"),
    (1986, "Katastrofa w Czarnobylu", "Chernobyl disaster"),
    (1989, "Upadek muru berlińskiego", "Fall of the Berlin Wall"),
    (1999, "Polska w NATO", "Poland joins NATO"),
    (2004, "Polska w Unii Europejskiej", "Poland joins the EU"),
    (2007, "Premiera pierwszego iPhone'a", "First iPhone released"),
]


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=np.uint8).tobytes()).decode()


def pool14(x: np.ndarray) -> np.ndarray:
    """28×28 → 14×14 (średnia 2×2) – wejście modelu w przeglądarce."""
    return x.reshape(-1, 14, 2, 14, 2).mean(axis=(2, 4)).round().astype(np.uint8)


def idx(path: Path, off: int) -> np.ndarray:
    with gzip.open(path) as f:
        return np.frombuffer(f.read()[off:], np.uint8)


def load_emnist() -> tuple[np.ndarray, np.ndarray]:
    import pyarrow.parquet as pq
    from PIL import Image

    rows = pq.read_table(DS / "emnist" / "test.parquet").to_pylist()
    x = np.stack([np.array(Image.open(io.BytesIO(r["image"]["bytes"]))).T for r in rows])  # EMNIST jest transponowany
    return x, np.array([r["label"] for r in rows])


def pairs_pl_en(rng: random.Random, n: int) -> list[tuple[str, str]]:
    from export_lexicon import LEX, load_oewn

    words, _, ili = load_oewn()
    en_by_sid: dict[str, str] = {}
    for lemma, sids in words.items():
        if lemma.isalpha() and lemma.islower() and 3 <= len(lemma) <= 12:
            for s in sids[:1]:
                en_by_sid.setdefault(s, lemma)
    with (LEX / "ili-map-pwn30.tab").open() as f:
        pwn2ili = dict(line.rstrip("\n").split("\t")[::-1] for line in f)
    ili2sid = {v: k for k, v in ili.items() if v}
    lex = json.loads((ROOT / "web" / "public" / "data" / "lexicon.json").read_text())
    common_en = {w for w, lang, _ in lex["words"] if lang == "en"}
    out = []
    seen: set[str] = set()
    with (LEX / "wn-data-pol.tab").open() as f:
        for line in f:
            if line.startswith("#"):
                continue
            p, kind, lem = line.rstrip("\n").split("\t")[:3]
            if kind != "pol:lemma" or not p.endswith("-n") or " " in lem or not 3 <= len(lem) <= 12:
                continue
            en = en_by_sid.get(ili2sid.get(pwn2ili.get(p, ""), ""))
            if en and en in common_en and lem not in seen and en not in seen and lem.lower() != en:
                seen |= {lem, en}
                out.append((lem.lower(), en))
    # popularność ≈ liczba znaczeń słowa w OEWN (słowa wieloznaczne są częstsze)
    out.sort(key=lambda pe: (-len(words.get(pe[1], [])), pe[1]))
    return out[:n]


def fashion_spare(nrng_perm: np.ndarray) -> list[int]:
    """Obrazy t10k spoza: zbioru testowego/puli rundy 1 (perm[:980]), odłamków ml (ziarno 2026, 3000) i zadań
    wzrokowych rundy 1 (v…, ziarno 1). Z nich runda ≥ 2 losuje tajnie pulę captcha i zadania wzrokowe."""
    used = set(nrng_perm[:980].tolist())
    q = np.random.default_rng(2026)
    q.permutation(60000)
    used |= set(q.permutation(10000)[:3000].tolist())
    used |= set(R1_VISUAL)
    return [i for i in range(10000) if i not in used]


# Indeksy t10k zadań wzrokowych rundy 1 (jawne w historii; odtworzone z ziarna 1 skryptu zadania_run.py).
R1_VISUAL = [
    82,
    232,
    241,
    475,
    582,
    712,
    746,
    771,
    865,
    915,
    926,
    972,
    1009,
    1063,
    1139,
    1198,
    1303,
    1536,
    1818,
    1937,
    2081,
    2267,
    2320,
    2332,
    2333,
    2512,
    2522,
    2534,
    2566,
    2648,
    3104,
    3433,
    3490,
    3502,
    3836,
    4048,
    4266,
    4297,
    4461,
    4527,
    4533,
    4556,
    4563,
    4672,
    4716,
    4733,
    4815,
    4940,
    4983,
    5121,
    5278,
    5291,
    5376,
    5431,
    5609,
    5619,
    5687,
    5720,
    5721,
    5754,
    5873,
    6037,
    6053,
    6401,
    6438,
    6479,
    6538,
    6593,
    6626,
    6659,
    7135,
    7151,
    7302,
    7405,
    7418,
    7429,
    7436,
    7472,
    7614,
    7665,
    7707,
    8134,
    8411,
    8502,
    8541,
    8562,
    8597,
    8891,
    8914,
    8932,
    9025,
    9066,
    9080,
    9294,
    9362,
    9627,
    9855,
    9941,
    9957,
    9984,
]


def main() -> None:
    rng = random.Random(11)  # jawne: zestawy startowe/testowe i odłamki (stałe od rundy 1)
    nrng = np.random.default_rng(11)
    grng = random.Random(goldkit.seed("captcha"))  # tajne: pule pytań kontrolnych
    gold: list[tuple[str, str]] = []

    # Fashion-MNIST: seed (z etykietami) z treningu, test z testu, pula z testu (bez etykiet)
    fx = idx(DS / "train-images-idx3-ubyte.gz", 16).reshape(-1, 28, 28)
    fy = idx(DS / "train-labels-idx1-ubyte.gz", 8)
    tx = idx(DS / "t10k-images-idx3-ubyte.gz", 16).reshape(-1, 28, 28)
    ty = idx(DS / "t10k-labels-idx1-ubyte.gz", 8)
    seed_i = np.concatenate([nrng.choice(np.where(fy == c)[0], 20, replace=False) for c in range(10)])
    perm = nrng.permutation(len(tx))
    test_i = perm[:500]
    spare = fashion_spare(perm)
    grng.shuffle(spare)
    pool_i, rot_i = spare[:360], spare[360:480]
    img_pool = []
    g_img = set(grng.sample(range(len(pool_i)), len(pool_i) // 3))  # które obrazy mają gold – tajne
    for k, i in enumerate(pool_i):
        qid = goldkit.rid("cg", k, 5)
        img_pool.append({"id": qid, "px": b64(tx[i])})
        if k in g_img:
            gold += [(f"{qid}k{c}", "tak" if ty[i] == c else "nie") for c in range(10)]
    rot = []
    for k, i in enumerate(rot_i):
        r = grng.randrange(4)
        img = np.rot90(tx[i], k=r)  # obrócone o r×90° w lewo → potrzebny obrót w prawo r razy
        qid = goldkit.rid("cr", k, 5)
        rot.append({"id": qid, "px": b64(img)})
        gold.append((qid, ROT[r]))

    # EMNIST litery
    ex, ey = load_emnist()
    eperm = nrng.permutation(len(ex))
    seed_e = np.concatenate([[i for i in eperm if ey[i] == c][:20] for c in range(26)])
    seed_set = set(seed_e.tolist())
    rest = np.array([i for i in eperm if i not in seed_set])
    etest, epool1 = rest[:520], rest[520:920]  # epool1 = jawna pula rundy 1 (już nie pytania)
    e_used1 = seed_set | set(etest.tolist()) | set(epool1.tolist())
    e_fed = [i for i in eperm if i not in e_used1][: 30 * 200]  # odłamki FedAvg (jak w rundzie 1)
    fed_set = set(e_fed)
    e_spare = [int(i) for i in eperm if i not in e_used1 and i not in fed_set]
    grng.shuffle(e_spare)
    epool = e_spare[:400]
    letters = []
    g_let = set(grng.sample(range(len(epool)), len(epool) // 3))
    for k, i in enumerate(epool):
        qid = goldkit.rid("ct", k, 5)
        letters.append({"id": qid, "px": b64(ex[i])})
        if k in g_let:
            gold.append((qid, chr(97 + int(ey[i]))))

    # kolejność wydarzeń (uczciwie: lata są w EVENTS w kodzie – to zadanie sprawdza wiedzę, nie sekret)
    order = []
    for k in range(80):
        evs = grng.sample(EVENTS, 4)
        qid = goldkit.rid("co", k, 5)
        order.append({"id": qid, "items": [{"pl": pl, "en": en} for _, pl, en in evs]})
        gold.append((qid, "".join("abcd"[j] for j in sorted(range(4), key=lambda j: evs[j][0]))))

    # pary PL↔EN: 240 najpopularniejszych = jawna pula rundy 1; runda ≥ 2 – kolejne 240, tajna kolejność
    pp = pairs_pl_en(rng, 480)[240:]
    grng.shuffle(pp)
    pairs = []
    g_pair = set(grng.sample(range(len(pp)), len(pp) // 3))
    for k, (pl, en) in enumerate(pp):
        qid = goldkit.rid("cm", k, 5)
        pairs.append({"id": qid, "pl": pl, "en": en})
        if k in g_pair:
            gold.append((qid, "tak"))

    out = {
        "version": 1,
        "fashion": {
            "classes_pl": FMNIST_PL,
            "classes_en": FMNIST_EN,
            "seed": {"px": b64(pool14(fx[seed_i])), "y": fy[seed_i].tolist()},
            "test": {"px": b64(pool14(tx[test_i])), "y": ty[test_i].tolist()},
            "pool": img_pool,
            "rotate": rot,
        },
        "letters": {
            "seed": {"px": b64(pool14(ex[seed_e])), "y": ey[seed_e].tolist()},
            "test": {"px": b64(pool14(ex[etest])), "y": ey[etest].tolist()},
            "pool": letters,
        },
        "order": order,
        "pairs": pairs,
        "sources": [
            "Fashion-MNIST (MIT)",
            "EMNIST letters (NIST, public domain)",
            "Open English WordNet 2025 (CC-BY-4.0)",
            "plWordNet via OMW (plWordNet licence)",
        ],
    }
    # Odłamki do trybu „Start sesji” (FedAvg w przeglądarkach): 30 × 200 próbek z etykietami,
    # rozłączne z zestawem testowym i pulą pytań; format: 200 × (196 bajtów 14×14 + 1 bajt etykiety).
    fed = ROOT / "web" / "public" / "data" / "fed"
    fed.mkdir(exist_ok=True)
    f_used = set(seed_i.tolist())
    f_rest = np.array([i for i in nrng.permutation(len(fx)) if i not in f_used])[: 30 * 200]
    e_rest = np.array(e_fed)
    for name, X, Y, ids in (("fashion", fx, fy, f_rest), ("letters", ex, ey, e_rest)):
        for s_ in range(30):
            part = ids[s_ * 200 : (s_ + 1) * 200]
            buf = np.concatenate(
                [pool14(X[part]).reshape(len(part), 196), np.asarray(Y[part], np.uint8).reshape(-1, 1)], axis=1
            )
            (fed / f"{name}-{s_:02d}.bin").write_bytes(buf.astype(np.uint8).tobytes())

    dest = ROOT / "web" / "public" / "data" / "captcha.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    goldkit.write("captcha", gold, "scripts/export_captcha.py")
    by = defaultdict(int)
    for q, _ in gold:
        by[q[:2]] += 1
    print(
        f"obrazy {len(img_pool)}, obroty {len(rot)}, litery {len(letters)}, kolejność {len(order)}, pary {len(pairs)}, gold {dict(by)}, {dest.stat().st_size // 1024} KB"
    )


if __name__ == "__main__":
    main()
