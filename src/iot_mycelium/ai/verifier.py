"""Zaufany węzeł weryfikujący (cron GitHub Actions): niezależnie liczy trafność kandydatów modelu globalnego.

Pobiera oczekujących kandydatów (myc_candidates), ich wagi z Supabase Storage, liczy przejście w przód w numpy
według architektury z web/public/data/ml/meta.json na stałym zbiorze testowym i zgłasza wynik przez
myc_reeval_trusted (klucz z sekretu MYC_VERIFIER_KEY). Baza publikuje wersję dopiero po takiej ocenie.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np

from iot_mycelium.ai.node import SUPABASE_KEY, SUPABASE_URL

ROOT = Path(__file__).resolve().parents[3]
ML = ROOT / "web" / "public" / "data" / "ml"


def _req(method: str, url: str, body: Any = None, raw: bool = False) -> Any:
    data = None if body is None else json.dumps(body).encode()
    for i in range(5):
        r = urllib.request.Request(url, data=data, method=method)  # noqa: S310
        r.add_header("apikey", SUPABASE_KEY)
        r.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(r, timeout=60) as f:  # noqa: S310 (stały adres Supabase)
                b = f.read()
            return b if raw else json.loads(b or b"null")
        except urllib.error.HTTPError as e:
            # treść odpowiedzi PostgREST (kod SQLSTATE + komunikat) – bez nagłówków i bez klucza
            msg = f"HTTP {e.code} {url.split('?')[0].rsplit('/', 1)[-1]}: {e.read()[:400].decode(errors='replace')}"
            if e.code < 500 or i == 4:
                raise RuntimeError(msg) from None
            print(msg, flush=True)
            time.sleep(0.5 * 2**i)
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            if i == 4:
                raise
            time.sleep(0.5 * 2**i)
    return None


def load_test(md: dict, m: str) -> tuple[np.ndarray, np.ndarray]:
    u = (ML / m / "test.bin").read_bytes()
    rec = md["dim"] + 1
    a = np.frombuffer(u, np.uint8).reshape(-1, rec)
    x = a[:, : md["dim"]]
    x = x.astype(np.float32) / 255 if md["format"] == "dense-u8" else x.view(np.int8).astype(np.float32) / 127
    return x, a[:, md["dim"]].astype(np.int64)


def eval_sha(y: np.ndarray) -> str:
    return hashlib.sha256(",".join(map(str, y.tolist())).encode()).hexdigest()


def conv3(x: np.ndarray, w: np.ndarray, b: np.ndarray, same: bool) -> np.ndarray:
    """Splot 3×3 NHWC, krok 1 (jak tf.layers.conv2d); w: [3, 3, Cin, Cout]."""
    if same:
        x = np.pad(x, ((0, 0), (1, 1), (1, 1), (0, 0)))
    win = np.lib.stride_tricks.sliding_window_view(x, (3, 3), axis=(1, 2))  # N, H', W', C, 3, 3
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
            cin = h.shape[-1]
            w = take(3, 3, cin, L["f"])
            h = conv3(h, w, take(L["f"]), bool(L.get("same")))
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
        raise ValueError(f"rozmiar wag {flat.size} != {o}")
    return h


def evaluate(m: str, flat: np.ndarray) -> tuple[float, int, str]:
    md = json.loads((ML / "meta.json").read_text())[m]
    x, y = load_test(md, m)
    hit = 0
    for i in range(0, len(x), 250):
        p = forward(md["arch"]["layers"], flat, x[i : i + 250], md.get("shape") or [md["dim"]]).argmax(1)
        hit += int((p == y[i : i + 250]).sum())
    return hit / len(y), len(y), eval_sha(y)


def verify_taxo(key: str) -> None:
    """Kandydaci taksonomii: metryki przeliczone z opublikowanego przypisania (stały zbiór oceny, bez PyTorcha)."""
    from iot_mycelium.mesh import taxo

    p = ROOT / "web" / "public" / "data" / "taxo" / "inputs.json"
    if not p.exists():
        return
    inputs = json.loads(p.read_text())
    meta = json.loads((p.parent / "meta.json").read_text())
    if taxo.eval_sha(inputs) != meta["eval_sha"]:
        print("taksonomia: odcisk zbioru oceny nie zgadza się – pomijam")
        return
    rows = _req("POST", f"{SUPABASE_URL}/rest/v1/rpc/myc_tax_list", {"p_limit": 20}) or []
    for c in [r for r in rows if r["status"] == "pending"]:
        res = json.loads(_req("GET", f"{SUPABASE_URL}/storage/v1/object/public/myc-models/{c['path']}", raw=True))
        m = taxo.metrics(res, inputs["gold"], inputs["eval"])
        r = _req(
            "POST",
            f"{SUPABASE_URL}/rest/v1/rpc/myc_tax_verify_trusted",
            {"p_key": key, "p_id": c["id"], "p_acc": m["acc"]},
        )
        print(f"taksonomia v{c['version']}: deklaracja {c['acc']:.4f}, przeliczona {m['acc']:.4f} → {r}")


def verify_rozbior(key: str) -> None:
    """Kandydaci rozbioru zdań: role-F1 przeliczone w numpy na teście UD (PDB + LFG) z opublikowanych wag MYCRB2."""
    from iot_mycelium.rozbior import model, zbior

    d = ROOT / "web" / "public" / "data" / "rozbior"
    if not (d / "meta.json").exists():
        return
    rows = _req("POST", f"{SUPABASE_URL}/rest/v1/rpc/myc_rb_list", {"p_limit": 10}) or []
    pend = [r for r in rows if r["status"] == "pending"]
    if not pend:
        return
    test = zbior.local("test-", d)
    for c in pend:
        H, W = model.load(_req("GET", f"{SUPABASE_URL}/storage/v1/object/public/myc-models/{c['path']}", raw=True))
        m = zbior.evaluate(H, W, test)
        slim = {k: v for k, v in m.items() if k != "per_q"}
        r = _req(
            "POST",
            f"{SUPABASE_URL}/rest/v1/rpc/myc_rb_verify_trusted",
            {"p_key": key, "p_id": c["id"], "p_f1": m["role_f1"], "p_metrics": slim},
        )
        print(f"rozbiór v{c['version']}: deklaracja {c['f1']:.4f}, numpy {m['role_f1']:.4f} → {r}")


def main() -> int:
    key = os.environ.get("MYC_VERIFIER_KEY", "")
    if not key:
        print("brak MYC_VERIFIER_KEY")
        return 1
    try:
        verify_taxo(key)
    except Exception as e:  # noqa: BLE001 – błąd taksonomii nie zatrzymuje oceny modeli
        print(f"taksonomia: błąd {e}")
    try:
        verify_rozbior(key)
    except Exception as e:  # noqa: BLE001 – błąd rozbioru nie zatrzymuje oceny modeli
        print(f"rozbiór: błąd {e}")
    meta = json.loads((ML / "meta.json").read_text())
    cands = _req(
        "GET",
        f"{SUPABASE_URL}/rest/v1/myc_candidates?status=eq.pending&select=id,model,version,path,acc_claimed&order=id",
    )
    for c in cands:
        if "arch" not in meta.get(c["model"], {}):
            continue
        raw = _req("GET", f"{SUPABASE_URL}/storage/v1/object/public/myc-models/{c['path']}", raw=True)
        acc, n, sha = evaluate(c["model"], np.frombuffer(raw, np.float32))
        r = _req(
            "POST",
            f"{SUPABASE_URL}/rest/v1/rpc/myc_reeval_trusted",
            {"p_key": key, "p_candidate": c["id"], "p_acc": acc, "p_sha": sha, "p_n": n, "p_backend": "numpy"},
        )
        print(f"{c['model']} v{c['version']}: deklaracja {c['acc_claimed']:.4f}, numpy {acc:.4f} → {r}")
    if not cands:
        print("brak kandydatów")
    return 0


if __name__ == "__main__":
    sys.exit(main())
