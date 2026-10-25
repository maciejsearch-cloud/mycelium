"""Publiczne zbiory danych dla agentów Mycelium AI.

Każdy loader zwraca :class:`TaskData` z rozłącznymi zbiorami train / val / test. Zbiór testowy
jest zawsze odłożony i nie bierze udziału w treningu ani w doborze hiperparametrów.

Zbiory (pobierane przy pierwszym użyciu do ``IOT_MYCELIUM_DATASETS_DIR``,
domyślnie ``~/.cache/iot-mycelium/datasets``; nic nie trafia do repozytorium):

==================  ===========================================  ==================
zadanie             źródło                                       licencja
==================  ===========================================  ==================
``har``             UCI HAR (Anguita i in., 2013)                CC BY 4.0
``fashion_mnist``   Zalando Fashion-MNIST                        MIT
``intents``         CLINC150 „small” (Larson i in., 2019)        CC BY 3.0
``sensor_forecast`` NAB realKnownCause (Numenta)                 AGPL-3.0 (dane)
==================  ===========================================  ==================

Każde zadanie ma też syntetyczny odpowiednik o tych samych kształtach (``synthetic=True``
albo ``IOT_MYCELIUM_SYNTHETIC=1``) – używany w testach i CI, gdzie nie pobieramy danych.
"""

from __future__ import annotations

import gzip
import json
import os
import re
import time
import urllib.request
import zipfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

TASKS = ("har", "fashion_mnist", "intents", "sensor_forecast")

TASK_INFO: dict[str, dict[str, str]] = {
    "har": {
        "title_pl": "Rozpoznawanie aktywności (akcelerometr)",
        "title_en": "Human activity recognition (accelerometer)",
        "source": "UCI HAR – Human Activity Recognition Using Smartphones",
        "url": "https://archive.ics.uci.edu/dataset/240",
        "license": "CC BY 4.0",
    },
    "fashion_mnist": {
        "title_pl": "Klasyfikacja obrazów (Fashion-MNIST)",
        "title_en": "Image classification (Fashion-MNIST)",
        "source": "Zalando Research Fashion-MNIST",
        "url": "https://github.com/zalandoresearch/fashion-mnist",
        "license": "MIT",
    },
    "intents": {
        "title_pl": "Klasyfikacja intencji tekstu (CLINC150)",
        "title_en": "Text intent classification (CLINC150)",
        "source": "CLINC150 (data_small, bez out-of-scope)",
        "url": "https://github.com/clinc/oos-eval",
        "license": "CC BY 3.0",
    },
    "sensor_forecast": {
        "title_pl": "Prognoza i anomalie czujników IoT (NAB)",
        "title_en": "IoT sensor forecasting & anomalies (NAB)",
        "source": "Numenta Anomaly Benchmark – realKnownCause",
        "url": "https://github.com/numenta/NAB",
        "license": "AGPL-3.0 (dane NAB)",
    },
}

_NAB = "https://raw.githubusercontent.com/numenta/NAB/master"
_FMNIST = "https://raw.githubusercontent.com/zalandoresearch/fashion-mnist/master/data/fashion"
URLS = {
    "har": "https://archive.ics.uci.edu/static/public/240/human+activity+recognition+using+smartphones.zip",
    "fmnist_train_x": f"{_FMNIST}/train-images-idx3-ubyte.gz",
    "fmnist_train_y": f"{_FMNIST}/train-labels-idx1-ubyte.gz",
    "fmnist_test_x": f"{_FMNIST}/t10k-images-idx3-ubyte.gz",
    "fmnist_test_y": f"{_FMNIST}/t10k-labels-idx1-ubyte.gz",
    "clinc": "https://raw.githubusercontent.com/clinc/oos-eval/master/data/data_small.json",
    "nab_labels": f"{_NAB}/labels/combined_windows.json",
}
NAB_SERIES = (
    "machine_temperature_system_failure",
    "ambient_temperature_system_failure",
    "nyc_taxi",
)
for _s in NAB_SERIES:
    URLS[f"nab_{_s}"] = f"{_NAB}/data/realKnownCause/{_s}.csv"

FORECAST_WINDOW = 48
TEXT_MAX_LEN = 24
TEXT_BUCKETS = 2**14


@dataclass
class TaskData:
    """Zadanie gotowe do treningu: rozłączne zbiory train/val/test + metadane."""

    name: str
    kind: str  # "classification" | "forecasting"
    input_kind: str  # "tabular" | "image" | "text" | "sequence"
    X_train: np.ndarray
    y_train: np.ndarray
    X_val: np.ndarray
    y_val: np.ndarray
    X_test: np.ndarray
    y_test: np.ndarray
    n_classes: int = 0
    groups_train: np.ndarray | None = None  # naturalny podział na urządzenia (np. osoba, czujnik)
    class_names: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def input_shape(self) -> tuple[int, ...]:
        return tuple(self.X_train.shape[1:])

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "input_kind": self.input_kind,
            "input_shape": list(self.input_shape),
            "n_classes": self.n_classes,
            "n_train": len(self.X_train),
            "n_val": len(self.X_val),
            "n_test": len(self.X_test),
            "synthetic": bool(self.meta.get("synthetic")),
            **{k: v for k, v in TASK_INFO.get(self.name, {}).items()},
        }


# --------------------------------------------------------------------------- pobieranie


def datasets_dir() -> Path:
    path = Path(os.environ.get("IOT_MYCELIUM_DATASETS_DIR", Path.home() / ".cache" / "iot-mycelium" / "datasets"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def use_synthetic_default() -> bool:
    return os.environ.get("IOT_MYCELIUM_SYNTHETIC", "").lower() in {"1", "true", "yes"}


def download(key: str, filename: str | None = None, retries: int = 6) -> Path:
    """Pobiera plik (z ponowieniami – serwery UCI bywają kapryśne) do katalogu cache."""
    url = URLS[key]
    if not url.startswith("https://"):
        raise ValueError(f"Dozwolone są tylko adresy https: {url}")
    target = datasets_dir() / (filename or url.rsplit("/", 1)[-1].replace("+", "_"))
    if target.exists() and target.stat().st_size > 0:
        return target
    tmp = target.with_suffix(target.suffix + ".part")
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "iot-mycelium/0.3"})  # noqa: S310 – tylko https
            with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:  # noqa: S310
                while chunk := resp.read(1 << 20):
                    out.write(chunk)
            if key == "har" and not zipfile.is_zipfile(tmp):
                raise OSError("niekompletne archiwum")
            os.replace(tmp, target)
            return target
        except Exception as exc:  # sieć: ponawiamy
            last = exc
            time.sleep(min(2**attempt, 10))
    raise RuntimeError(f"Nie udało się pobrać {url}: {last}")


def _rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def _split_val(n: int, frac: float, seed: int, stratify: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    rng = _rng(seed)
    if stratify is None:
        idx = rng.permutation(n)
        k = int(round(n * frac))
        return np.sort(idx[k:]), np.sort(idx[:k])
    train, val = [], []
    for c in np.unique(stratify):
        ids = rng.permutation(np.flatnonzero(stratify == c))
        k = max(1, int(round(len(ids) * frac)))
        val.extend(ids[:k])
        train.extend(ids[k:])
    return np.sort(np.array(train)), np.sort(np.array(val))


# --------------------------------------------------------------------------- HAR


HAR_CLASSES = ["WALKING", "WALKING_UPSTAIRS", "WALKING_DOWNSTAIRS", "SITTING", "STANDING", "LAYING"]


def _har_root() -> Path:
    root = datasets_dir() / "UCI HAR Dataset"
    if root.exists():
        return root
    outer = download("har", "uci_har.zip")
    with zipfile.ZipFile(outer) as zf:
        inner = [n for n in zf.namelist() if n.endswith(".zip")]
        if inner:
            zf.extract(inner[0], datasets_dir())
            with zipfile.ZipFile(datasets_dir() / inner[0]) as zi:
                zi.extractall(datasets_dir())
        else:
            zf.extractall(datasets_dir())
    return root


def load_har(seed: int = 0, synthetic: bool | None = None) -> TaskData:
    """561 cech z akcelerometru i żyroskopu smartfona → 6 aktywności.

    Test = 9 osób oficjalnie odłożonych przez autorów (nie widzianych w treningu);
    ``groups_train`` = numer osoby, czyli naturalny, nie-IID podział na urządzenia.
    """
    if synthetic if synthetic is not None else use_synthetic_default():
        return _synthetic_classification("har", "tabular", (561,), 6, 1400, 600, seed, groups=12, names=HAR_CLASSES)
    root = _har_root()

    def part(split: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X = np.loadtxt(root / split / f"X_{split}.txt", dtype=np.float32)
        y = np.loadtxt(root / split / f"y_{split}.txt", dtype=np.int64) - 1
        s = np.loadtxt(root / split / f"subject_{split}.txt", dtype=np.int64)
        return X, y, s

    X, y, s = part("train")
    Xt, yt, _ = part("test")
    tr, va = _split_val(len(X), 0.15, seed, stratify=y)
    return TaskData(
        "har",
        "classification",
        "tabular",
        X[tr],
        y[tr],
        X[va],
        y[va],
        Xt,
        yt,
        n_classes=6,
        groups_train=s[tr],
        class_names=HAR_CLASSES,
        meta={"synthetic": False, "test_split": "9 osób odłożonych przez autorów zbioru"},
    )


# --------------------------------------------------------------------------- Fashion-MNIST


FMNIST_CLASSES = ["T-shirt", "Trouser", "Pullover", "Dress", "Coat", "Sandal", "Shirt", "Sneaker", "Bag", "Boot"]


def _idx(path: Path) -> np.ndarray:
    with gzip.open(path, "rb") as fh:
        data = fh.read()
    magic = int.from_bytes(data[:4], "big")
    ndim = magic & 0xFF
    dims = [int.from_bytes(data[4 + 4 * i : 8 + 4 * i], "big") for i in range(ndim)]
    return np.frombuffer(data, dtype=np.uint8, offset=4 + 4 * ndim).reshape(dims)


def load_fashion_mnist(
    seed: int = 0, n_train: int = 20000, n_test: int = 10000, synthetic: bool | None = None
) -> TaskData:
    """Obrazy 28×28 w 10 klasach. ``n_train`` ogranicza trening, żeby zmieścić się w CPU."""
    if synthetic if synthetic is not None else use_synthetic_default():
        return _synthetic_classification(
            "fashion_mnist", "image", (1, 28, 28), 10, 1500, 600, seed, names=FMNIST_CLASSES
        )
    X = _idx(download("fmnist_train_x")).astype(np.float32) / 255.0
    y = _idx(download("fmnist_train_y")).astype(np.int64)
    Xt = _idx(download("fmnist_test_x")).astype(np.float32) / 255.0
    yt = _idx(download("fmnist_test_y")).astype(np.int64)
    rng = _rng(seed)
    pick = rng.permutation(len(X))[: n_train + n_train // 5]
    X, y = X[pick], y[pick]
    tr, va = _split_val(len(X), 1 / 6, seed, stratify=y)
    mean, std = 0.2860, 0.3530
    norm = lambda a: ((a - mean) / std)[:, None, :, :].astype(np.float32)  # noqa: E731
    test_pick = np.sort(rng.permutation(len(Xt))[:n_test])
    return TaskData(
        "fashion_mnist",
        "classification",
        "image",
        norm(X[tr]),
        y[tr],
        norm(X[va]),
        y[va],
        norm(Xt[test_pick]),
        yt[test_pick],
        n_classes=10,
        class_names=FMNIST_CLASSES,
        meta={"synthetic": False, "test_split": "oficjalny zbiór testowy (t10k)"},
    )


# --------------------------------------------------------------------------- CLINC150 (tekst)


_TOKEN = re.compile(r"[a-z0-9']+")


def hash_tokens(text: str, max_len: int = TEXT_MAX_LEN, buckets: int = TEXT_BUCKETS) -> np.ndarray:
    """Bezstanowa tokenizacja: unigramy + bigramy haszowane do ``buckets`` (0 = padding).

    Brak słownika oznacza, że każde urządzenie tokenizuje identycznie bez wymiany danych –
    kluczowe w uczeniu federacyjnym.
    """
    words = _TOKEN.findall(text.lower())
    grams = words + [f"{a}_{b}" for a, b in zip(words, words[1:])]
    ids = [1 + zlib.crc32(g.encode()) % (buckets - 1) for g in grams][:max_len]
    out = np.zeros(max_len, dtype=np.int64)
    out[: len(ids)] = ids
    return out


def load_intents(seed: int = 0, synthetic: bool | None = None) -> TaskData:
    """Krótkie polecenia użytkownika → 150 intencji (CLINC150 small, bez out-of-scope)."""
    if synthetic if synthetic is not None else use_synthetic_default():
        return _synthetic_text(seed)
    raw = json.loads(download("clinc").read_text())
    names = sorted({lab for _, lab in raw["train"]})
    index = {n: i for i, n in enumerate(names)}

    def enc(rows: list[list[str]]) -> tuple[np.ndarray, np.ndarray]:
        return np.stack([hash_tokens(t) for t, _ in rows]), np.array([index[lab] for _, lab in rows], dtype=np.int64)

    X, y = enc(raw["train"])
    Xv, yv = enc(raw["val"])
    Xt, yt = enc(raw["test"])
    return TaskData(
        "intents",
        "classification",
        "text",
        X,
        y,
        Xv,
        yv,
        Xt,
        yt,
        n_classes=len(names),
        class_names=names,
        meta={"synthetic": False, "test_split": "oficjalny test CLINC150 (30 zdań na intencję)"},
    )


def encode_text(texts: list[str]) -> np.ndarray:
    return np.stack([hash_tokens(t) for t in texts])


# --------------------------------------------------------------------------- NAB (czujniki)


def _nab_series(name: str) -> tuple[np.ndarray, np.ndarray]:
    path = download(f"nab_{name}")
    ts, vals = [], []
    for line in path.read_text().splitlines()[1:]:
        t, v = line.split(",")
        ts.append(np.datetime64(t.replace(" ", "T")))
        vals.append(float(v))
    return np.array(ts), np.array(vals, dtype=np.float32)


def _windows(values: np.ndarray, window: int) -> tuple[np.ndarray, np.ndarray]:
    view = np.lib.stride_tricks.sliding_window_view(values, window + 1)
    return view[:, :window].copy(), view[:, window].copy()


def load_sensor_forecast(seed: int = 0, window: int = FORECAST_WINDOW, synthetic: bool | None = None) -> TaskData:
    """Prognoza następnego odczytu czujnika z okna ``window`` poprzednich (NAB).

    Każdy szereg jest dzielony chronologicznie 60/20/20 (bez przecieków z przyszłości) i
    standaryzowany statystykami części treningowej. ``groups_train`` = czujnik × połowa okresu,
    czyli 6 naturalnych urządzeń. ``extra`` zawiera pełne szeregi i etykiety okien anomalii
    do ewaluacji wykrywania anomalii (etykiety nie są używane w treningu).
    """
    if synthetic if synthetic is not None else use_synthetic_default():
        return _synthetic_forecast(seed, window)
    labels = json.loads(download("nab_labels").read_text())
    parts: dict[str, list[np.ndarray]] = {k: [] for k in ("Xtr", "ytr", "Xva", "yva", "Xte", "yte", "g")}
    series: dict[str, Any] = {}
    for si, name in enumerate(NAB_SERIES):
        ts, vals = _nab_series(name)
        n = len(vals)
        a, b = int(n * 0.6), int(n * 0.8)
        mu, sd = float(vals[:a].mean()), float(vals[:a].std() + 1e-6)
        z = (vals - mu) / sd
        X, y = _windows(z, window)  # y[i] odpowiada z[i + window]
        tgt = np.arange(len(y)) + window
        tr, va, te = tgt < a, (tgt >= a) & (tgt < b), tgt >= b
        parts["Xtr"].append(X[tr])
        parts["ytr"].append(y[tr])
        parts["Xva"].append(X[va])
        parts["yva"].append(y[va])
        parts["Xte"].append(X[te])
        parts["yte"].append(y[te])
        half = (tgt[tr] >= a // 2).astype(np.int64)
        parts["g"].append(si * 2 + half)
        wins = [
            (np.datetime64(s.replace(" ", "T")), np.datetime64(e.replace(" ", "T")))
            for s, e in labels[f"realKnownCause/{name}.csv"]
        ]
        anomaly = np.zeros(n, dtype=bool)
        for s, e in wins:
            anomaly |= (ts >= s) & (ts <= e)
        series[name] = {
            "timestamps": ts,
            "values": vals,
            "z": z.astype(np.float32),
            "mean": mu,
            "std": sd,
            "anomaly": anomaly,
            "windows": [(int(np.searchsorted(ts, s)), int(np.searchsorted(ts, e))) for s, e in wins],
            "split": (a, b),
        }
    cat = lambda k: np.concatenate(parts[k]).astype(np.float32)  # noqa: E731
    return TaskData(
        "sensor_forecast",
        "forecasting",
        "sequence",
        cat("Xtr"),
        cat("ytr"),
        cat("Xva"),
        cat("yva"),
        cat("Xte"),
        cat("yte"),
        groups_train=np.concatenate(parts["g"]),
        meta={"synthetic": False, "test_split": "ostatnie 20% każdego szeregu (chronologicznie)", "window": window},
        extra={"series": series},
    )


# --------------------------------------------------------------------------- dane syntetyczne


def _synthetic_classification(
    name: str,
    input_kind: str,
    shape: tuple[int, ...],
    n_classes: int,
    n_train: int,
    n_test: int,
    seed: int,
    groups: int | None = None,
    names: list[str] | None = None,
) -> TaskData:
    rng = _rng(seed + 101)
    d = int(np.prod(shape))
    centers = rng.normal(0, 1, (n_classes, d)).astype(np.float32)

    def make(n: int) -> tuple[np.ndarray, np.ndarray]:
        y = rng.integers(0, n_classes, n)
        X = centers[y] * 0.6 + rng.normal(0, 1, (n, d)).astype(np.float32)
        return X.reshape((n, *shape)).astype(np.float32), y.astype(np.int64)

    X, y = make(n_train)
    Xt, yt = make(n_test)
    tr, va = _split_val(len(X), 0.15, seed, stratify=y)
    g = None
    if groups:
        # każda „osoba” ma przesunięcie cech i preferencję klas → dane nie-IID
        g_all = rng.integers(0, groups, len(X))
        g = g_all[tr]
    return TaskData(
        name,
        "classification",
        input_kind,
        X[tr],
        y[tr],
        X[va],
        y[va],
        Xt,
        yt,
        n_classes=n_classes,
        groups_train=g,
        class_names=names or [str(i) for i in range(n_classes)],
        meta={"synthetic": True, "test_split": "syntetyczny"},
    )


def _synthetic_text(seed: int) -> TaskData:
    rng = _rng(seed + 202)
    n_classes, vocab = 12, 400
    keywords = rng.integers(0, vocab, (n_classes, 3))
    names = [f"intent_{i}" for i in range(n_classes)]

    def make(n: int) -> tuple[np.ndarray, np.ndarray]:
        y = rng.integers(0, n_classes, n)
        texts = []
        for c in y:
            words = [f"w{w}" for w in rng.integers(0, vocab, rng.integers(3, 8))]
            words.insert(int(rng.integers(0, len(words))), f"w{keywords[c][rng.integers(0, 3)]}")
            texts.append(" ".join(words))
        return encode_text(texts), y.astype(np.int64)

    X, y = make(900)
    Xv, yv = make(200)
    Xt, yt = make(300)
    return TaskData(
        "intents",
        "classification",
        "text",
        X,
        y,
        Xv,
        yv,
        Xt,
        yt,
        n_classes=n_classes,
        class_names=names,
        meta={"synthetic": True},
    )


def _synthetic_forecast(seed: int, window: int) -> TaskData:
    rng = _rng(seed + 303)
    parts: dict[str, list[np.ndarray]] = {k: [] for k in ("Xtr", "ytr", "Xva", "yva", "Xte", "yte", "g")}
    series = {}
    for si in range(3):
        n = 1500
        t = np.arange(n)
        vals = (np.sin(2 * np.pi * t / (48 + 24 * si)) + 0.1 * rng.normal(size=n)).astype(np.float32)
        anomaly = np.zeros(n, dtype=bool)
        start = int(rng.integers(1000, 1350))
        vals[start : start + 30] += 3.0
        anomaly[start - 10 : start + 40] = True
        a, b = int(n * 0.6), int(n * 0.8)
        mu, sd = float(vals[:a].mean()), float(vals[:a].std() + 1e-6)
        z = ((vals - mu) / sd).astype(np.float32)
        X, y = _windows(z, window)
        tgt = np.arange(len(y)) + window
        tr, va, te = tgt < a, (tgt >= a) & (tgt < b), tgt >= b
        for key, m in (("Xtr", tr), ("Xva", va), ("Xte", te)):
            parts[key].append(X[m])
            parts["y" + key[1:]].append(y[m])
        parts["g"].append(si * 2 + (tgt[tr] >= a // 2))
        series[f"synthetic_{si}"] = {
            "timestamps": np.arange(n),
            "values": vals,
            "z": z,
            "mean": mu,
            "std": sd,
            "anomaly": anomaly,
            "windows": [(start - 10, start + 40)],
            "split": (a, b),
        }
    cat = lambda k: np.concatenate(parts[k]).astype(np.float32)  # noqa: E731
    return TaskData(
        "sensor_forecast",
        "forecasting",
        "sequence",
        cat("Xtr"),
        cat("ytr"),
        cat("Xva"),
        cat("yva"),
        cat("Xte"),
        cat("yte"),
        groups_train=np.concatenate(parts["g"]).astype(np.int64),
        meta={"synthetic": True, "window": window},
        extra={"series": series},
    )


LOADERS = {
    "har": load_har,
    "fashion_mnist": load_fashion_mnist,
    "intents": load_intents,
    "sensor_forecast": load_sensor_forecast,
}


def load_task(name: str, seed: int = 0, synthetic: bool | None = None) -> TaskData:
    if name not in LOADERS:
        raise ValueError(f"Nieznane zadanie {name!r}; dostępne: {', '.join(TASKS)}")
    return LOADERS[name](seed=seed, synthetic=synthetic)
