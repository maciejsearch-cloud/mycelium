#!/usr/bin/env python3
"""Niezależna, odtwarzalna ocena wersji modelu grzybni – każdy może ją uruchomić.

Wymaga tylko Pythona 3.10+ i numpy. Pobiera publicznie: listę wersji (Supabase REST, klucz publikowalny),
zapisane wagi wersji (Supabase Storage), architekturę i STAŁY zbiór testowy (strona demo), liczy przejście
w przód i trafność, a odcisk sha256 etykiet testu porównuje z myc_eval_sets.

  python scripts/verify_model.py --model fashion --version 47
  python scripts/verify_model.py --latest          # najnowsza wersja każdego modelu
  python scripts/verify_model.py --latest --json wynik.json

Kod wyjścia 1, gdy przeliczona trafność różni się od zapisanej o więcej niż --tol (domyślnie 0,5 pkt proc.)
albo odcisk zbioru testowego się nie zgadza.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np

SB = "https://agortpieeygmcttjwjfx.supabase.co"
KEY = "sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P"  # publiczny z założenia (RLS, tylko odczyt)
DEMO = "https://maciejsearch-cloud.github.io/demo/mycelium/data/ml"
LOCAL = Path(__file__).resolve().parents[1] / "web" / "public" / "data" / "ml"
MODELS = ("fashion", "har", "intent", "words")


def get(url: str, raw: bool = False, api: bool = False) -> Any:
    for i in range(5):
        h = {"apikey": KEY, "User-Agent": "myc-verify"} if api else {"User-Agent": "myc-verify"}
        r = urllib.request.Request(url, headers=h)  # noqa: S310 (stałe publiczne adresy https)
        try:
            with urllib.request.urlopen(r, timeout=60) as f:  # noqa: S310 (stałe publiczne adresy)
                b = f.read()
            return b if raw else json.loads(b)
        except OSError:
            if i == 4:
                raise
            time.sleep(0.5 * 2**i)
    return None


def data_file(rel: str, local: bool) -> bytes:
    p = LOCAL / rel
    if local and p.exists():
        return p.read_bytes()
    return get(f"{DEMO}/{rel}", raw=True)


def load_test(md: dict, m: str, local: bool) -> tuple[np.ndarray, np.ndarray]:
    u = data_file(f"{m}/test.bin", local)
    rec = md["dim"] + 1
    a = np.frombuffer(u, np.uint8).reshape(-1, rec)
    x = a[:, : md["dim"]]
    x = x.astype(np.float32) / 255 if md["format"] == "dense-u8" else x.view(np.int8).astype(np.float32) / 127
    return x, a[:, md["dim"]].astype(np.int64)


def conv3(x: np.ndarray, w: np.ndarray, b: np.ndarray, same: bool) -> np.ndarray:
    if same:
        x = np.pad(x, ((0, 0), (1, 1), (1, 1), (0, 0)))
    win = np.lib.stride_tricks.sliding_window_view(x, (3, 3), axis=(1, 2))
    return np.einsum("nhwcij,ijco->nhwo", win, w, optimize=True) + b


def forward(layers: list[dict], flat: np.ndarray, x: np.ndarray, shape: list[int]) -> np.ndarray:
    o = 0

    def take(*shp: int) -> np.ndarray:
        nonlocal o
        n = int(np.prod(shp))
        t = flat[o : o + n].reshape(shp)
        o += n
        return t

    h = x.reshape(-1, *shape)
    for L in layers:
        t = L["t"]
        if t == "conv":
            h = conv3(h, take(3, 3, h.shape[-1], L["f"]), take(L["f"]), bool(L.get("same")))
        elif t == "pool":
            n, hh, ww, c = h.shape
            h = h[:, : hh // 2 * 2, : ww // 2 * 2].reshape(n, hh // 2, 2, ww // 2, 2, c).max((2, 4))
        elif t == "flatten":
            h = h.reshape(h.shape[0], -1)
        elif t == "dense":
            w = take(h.shape[-1], L["u"])
            h = h @ w + take(L["u"])
        elif t == "bn":
            c = h.shape[-1]
            g, be, mu, var = take(c), take(c), take(c), take(c)
            h = (h - mu) / np.sqrt(var + 1e-3) * g + be
        if L.get("relu"):
            h = np.maximum(h, 0)
    if o != flat.size:
        raise ValueError(f"rozmiar wag {flat.size} != oczekiwany {o}")
    return h


def n_params(layers: list[dict], shape: list[int]) -> int:
    """Liczba wag oczekiwana przez bieżącą architekturę (bez pobierania wag)."""
    shp, n = list(shape), 0
    for L in layers:
        t = L["t"]
        if t == "conv":
            n += 9 * shp[-1] * L["f"] + L["f"]
            shp = [shp[0], shp[1], L["f"]] if L.get("same") else [shp[0] - 2, shp[1] - 2, L["f"]]
        elif t == "pool":
            shp = [shp[0] // 2, shp[1] // 2, shp[2]]
        elif t == "flatten":
            shp = [int(np.prod(shp))]
        elif t == "dense":
            n += shp[-1] * L["u"] + L["u"]
            shp = [*shp[:-1], L["u"]]
        elif t == "bn":
            n += 4 * shp[-1]
    return n


def verify(row: dict, meta: dict, sets: dict, local: bool) -> dict:
    m = row["model"]
    md = meta[m]
    w = get(f"{SB}/storage/v1/object/public/myc-models/{row['path']}", raw=True)
    flat = np.frombuffer(w, np.float32)
    x, y = load_test(md, m, local)
    hit = 0
    for i in range(0, len(x), 250):
        p = forward(md["arch"]["layers"], flat, x[i : i + 250], md.get("shape") or [md["dim"]]).argmax(1)
        hit += int((p == y[i : i + 250]).sum())
    sha = hashlib.sha256(",".join(map(str, y.tolist())).encode()).hexdigest()
    acc = hit / len(y)
    return {
        "model": m,
        "version": row["version"],
        "weights": row["path"],
        "weights_sha256": hashlib.sha256(w).hexdigest(),
        "n_params": int(flat.size),
        "eval_n": len(y),
        "eval_sha256": sha,
        "eval_sha_matches_db": sets.get(m) == sha,
        "acc_recomputed": round(acc, 6),
        "acc_stored": row["acc"],
        "diff_pp": round((acc - (row["acc"] or 0)) * 100, 3),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", choices=MODELS)
    ap.add_argument("--version", type=int)
    ap.add_argument("--latest", action="store_true", help="najnowsza wersja każdego modelu (lub --model)")
    ap.add_argument("--tol", type=float, default=0.5, help="dopuszczalna różnica w pkt proc.")
    ap.add_argument("--json", help="zapisz wyniki do pliku JSON")
    ap.add_argument("--unverified", type=int, metavar="N", help="do N wersji bez wpisu w myc_ci_evals (dla CI)")
    ap.add_argument("--post", action="store_true", help="CI: zapisz wyniki publicznie (wymaga MYC_CI_EVAL_KEY)")
    ap.add_argument("--remote-data", action="store_true", help="zbiór testowy zawsze ze strony demo (nie z repo)")
    a = ap.parse_args()
    if not a.latest and a.unverified is None and (a.model is None or a.version is None):
        ap.error("podaj --model i --version, --latest albo --unverified N")
    meta = json.loads(data_file("meta.json", not a.remote_data))
    sets = {r["model"]: r["sha"] for r in get(f"{SB}/rest/v1/myc_eval_sets?select=model,sha", api=True)}
    rows: list[dict] = []
    if a.unverified is not None:
        done = {(r["model"], r["version"]) for r in get(f"{SB}/rest/v1/myc_ci_evals?select=model,version", api=True)}
        allv = get(f"{SB}/rest/v1/myc_models?select=model,version,path,acc&order=created_at.desc&limit=2000", api=True)
        rows = [r for r in allv if (r["model"], r["version"]) not in done and "arch" in meta.get(r["model"], {})][
            : a.unverified
        ]
        if not rows:
            print("wszystkie wersje już ponownie ocenione")
            return 0
    for m in [] if a.unverified is not None else [a.model] if a.model else MODELS:
        q = (
            f"model=eq.{m}&version=eq.{a.version}"
            if a.version is not None
            else f"model=eq.{m}&order=version.desc&limit=1"
        )
        rows += get(f"{SB}/rest/v1/myc_models?select=model,version,path,acc&{q}", api=True)
    if not rows:
        print("nie znaleziono wersji")
        return 1
    out, bad = [], 0
    for r in rows:
        v = verify(r, meta, sets, not a.remote_data)
        ok = abs(v["diff_pp"]) <= a.tol and v["eval_sha_matches_db"]
        v["ok"] = ok
        bad += not ok
        out.append(v)
        print(
            f"{'OK ' if ok else 'ŹLE'} {v['model']:8s} v{v['version']:<4d} zapisane {v['acc_stored']:.4f}  przeliczone {v['acc_recomputed']:.4f}"
            f"  różnica {v['diff_pp']:+.2f} pp  test n={v['eval_n']} sha={v['eval_sha256'][:12]} ({'zgodny' if v['eval_sha_matches_db'] else 'NIEZGODNY'})"
        )
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1, ensure_ascii=False))
    if a.post:
        run = os.environ.get("GITHUB_RUN_ID")
        url = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{run}" if run else None
        body = json.dumps({"p_key": os.environ["MYC_CI_EVAL_KEY"], "p_rows": out, "p_run_url": url}).encode()
        h = {"apikey": KEY, "Content-Type": "application/json", "User-Agent": "myc-verify"}
        r = urllib.request.Request(f"{SB}/rest/v1/rpc/myc_ci_eval", data=body, headers=h, method="POST")  # noqa: S310
        with urllib.request.urlopen(r, timeout=60) as f:  # noqa: S310
            print("zapisano publicznie:", f.read().decode())
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
