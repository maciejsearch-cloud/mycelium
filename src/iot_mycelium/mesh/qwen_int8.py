"""Wagi Qwen2.5-0.5B w int8 (opcjonalne pobieranie dla węzłów): ok. 0,55 GB zamiast 0,99 GB bf16.

Format: zwykły plik safetensors. Macierze MLP (gate/up/down) i osadzenia są zapisane jako ``I8`` z osobną skalą
na wiersz ``<nazwa>.scale`` (``F32``): ``w[r, c] ≈ q[r, c] · scale[r]``, ``scale = max|w[r]| / 127``,
``q = floor(w · (1 / scale) + 0,5)`` – dokładnie ta sama kwantyzacja co w przeglądarce (``web/src/mesh/qwen.ts:
quantRows``), więc te macierze dają w przeglądarce bit w bit to samo co dziś. Projekcje uwagi (q/k/v/o), normy
i biasy zostają w bf16: do nich dokładany jest adapter LoRA grzybni, więc zostają bez dodatkowego szumu.

Plik powstaje deterministycznie z oryginału (SHA-256 oryginału w metadanych) – każdy może go odtworzyć:
    python -m iot_mycelium.mesh.qwen_int8 qwen2.5-0.5b-instruct.safetensors out.safetensors
Ocena modelu (bramka wersji, weryfikator f32) zawsze używa oryginalnych wag bf16 z Hugging Face.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import struct
import sys
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path

import torch

FORMAT = "mycelium-int8-v1"
TAG = "qwen-int8-v1"
NAME = "qwen2.5-0.5b-instruct-int8.safetensors"
URL = f"https://github.com/maciejsearch-cloud/mycelium/releases/download/{TAG}/{NAME}"
SHA256 = "b68be1b17d4b0b52c03d6f3a6375b3e9cd0c752673d11850d21620196dbf47de"  # plik wydania qwen-int8-v1 (539 812 664 B)
QUANT = ("mlp.gate_proj.weight", "mlp.up_proj.weight", "mlp.down_proj.weight", "model.embed_tokens.weight")


def is_quantized(name: str) -> bool:
    return name.endswith(QUANT)


def quant_rows(w: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Kwantyzacja int8 ze skalą na wiersz, zaokrąglenie jak ``Math.round`` w przeglądarce (połówki w górę)."""
    x = w.to(torch.float64)
    m = x.abs().amax(1).to(torch.float32).to(torch.float64)  # max|bf16| jest dokładnie reprezentowalne w f32
    sc = m / 127
    sc = torch.where(sc == 0, torch.ones_like(sc), sc)
    q = torch.floor(x * (1.0 / sc)[:, None] + 0.5).clamp(-127, 127).to(torch.int8)
    return q, sc.to(torch.float32)


def dequant(q: torch.Tensor, scale: torch.Tensor, dtype=torch.float32) -> torch.Tensor:
    return (q.to(torch.float32) * scale[:, None]).to(dtype)


def _header(path: Path) -> tuple[dict, int]:
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        return json.loads(f.read(n)), 8 + n


def _view(raw: torch.Tensor, a: int, b: int, dtype: torch.dtype) -> torch.Tensor:
    """Fragment bajtów jako tensor ``dtype`` (kopia, gdy przesunięcie nie jest wyrównane do rozmiaru elementu)."""
    seg = raw[a:b]
    if seg.storage_offset() % torch.empty(0, dtype=dtype).element_size():
        seg = seg.clone()
    return seg.view(dtype)


def _raw(t: torch.Tensor) -> bytes:
    from .lm import tobytes

    return tobytes(t)


def convert(src: Path, dst: Path, src_sha: str, log: Callable[[str], None] = print) -> str:
    """bf16 → int8 (deterministycznie). Zwraca SHA-256 pliku wynikowego."""
    h, base = _header(src)
    h.pop("__metadata__", None)
    raw = torch.from_file(str(src), shared=False, size=src.stat().st_size, dtype=torch.uint8)
    names = sorted(h)
    plan: list[tuple[str, str, list[int], int]] = []  # nazwa, dtype, kształt, bajty
    for k in names:
        t = h[k]
        if t["dtype"] != "BF16":
            raise ValueError(f"{k}: oczekiwano BF16, jest {t['dtype']}")
        if is_quantized(k):
            plan += [
                (k, "I8", t["shape"], t["shape"][0] * t["shape"][1]),
                (k + ".scale", "F32", [t["shape"][0]], 4 * t["shape"][0]),
            ]
        else:
            plan.append((k, "BF16", t["shape"], t["data_offsets"][1] - t["data_offsets"][0]))
    out: dict = {"__metadata__": {"format": FORMAT, "source": "Qwen/Qwen2.5-0.5B-Instruct", "source_sha256": src_sha,
                                  "quant": "I8 per-row absmax/127, floor(x/s+0.5); attention q/k/v/o, norms, biases bf16"}}  # fmt: skip
    off = 0
    for k, dt, shape, nb in plan:
        out[k] = {"dtype": dt, "shape": shape, "data_offsets": [off, off + nb]}
        off += nb
    hb = json.dumps(out, separators=(",", ":")).encode()
    hb += b" " * ((8 - len(hb) % 8) % 8)
    sha = hashlib.sha256()
    tmp = dst.with_suffix(".tmp")
    with open(tmp, "wb") as f:

        def put(b: bytes) -> None:
            f.write(b)
            sha.update(b)

        put(struct.pack("<Q", len(hb)) + hb)
        for k in names:
            t = h[k]
            a, b = t["data_offsets"]
            if is_quantized(k):
                w = _view(raw, base + a, base + b, torch.bfloat16).reshape(t["shape"])
                parts = [quant_rows(w[i : i + 4096]) for i in range(0, w.shape[0], 4096)]  # mało RAM (f64)
                for q, _ in parts:
                    put(_raw(q))
                put(_raw(torch.cat([sc for _, sc in parts])))
            else:
                put(_raw(raw[base + a : base + b]))
    tmp.replace(dst)
    log(f"zapisano {dst} ({dst.stat().st_size / 1e6:.1f} MB)")
    return sha.hexdigest()


def load_dequant(path: Path, dtype=torch.float32) -> dict[str, torch.Tensor]:
    """Wczytuje plik int8 (albo zwykły bf16) i zwraca tensory w ``dtype`` – jak ``qwen.load_safetensors``."""
    h, base = _header(path)
    h.pop("__metadata__", None)
    raw = torch.from_file(str(path), shared=False, size=path.stat().st_size, dtype=torch.uint8)
    out = {}
    for k, t in h.items():
        if k.endswith(".scale"):
            continue
        a, b = t["data_offsets"]
        if t["dtype"] == "I8":
            s = h[k + ".scale"]
            q = _view(raw, base + a, base + b, torch.int8).reshape(t["shape"])
            sc = _view(raw, base + s["data_offsets"][0], base + s["data_offsets"][1], torch.float32)
            out[k] = dequant(q, sc, dtype)
        elif t["dtype"] == "BF16":
            out[k] = _view(raw, base + a, base + b, torch.bfloat16).reshape(t["shape"]).to(dtype)
        else:
            raise ValueError(f"{k}: nieobsługiwany typ {t['dtype']}")
    return out


def _sha_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while chunk := f.read(8 << 20):
            h.update(chunk)
    return h.hexdigest()


def ensure_int8(cache: Path, log: Callable[[str], None] = print, url: str = URL, sha256: str = SHA256) -> Path | None:
    """Pobiera plik int8 (wznawianie, SHA-256). None = niedostępny – wołający wraca do oryginału bf16 z HF."""
    if not sha256:
        log("wagi int8: brak opublikowanej sumy – używam bf16")
        return None
    p = cache / NAME
    mark = p.with_suffix(".sha256ok")
    if p.exists():
        st = p.stat()
        tag = f"{sha256} {st.st_size} {int(st.st_mtime)}"
        if mark.exists() and mark.read_text().strip() == tag:
            return p
        if _sha_file(p) == sha256:
            mark.write_text(tag)
            return p
        p.unlink()
    cache.mkdir(parents=True, exist_ok=True)
    part = p.with_suffix(".part")
    with open(p.with_suffix(".lock"), "w") as lock:
        with contextlib.suppress(ImportError):
            import fcntl

            fcntl.flock(lock, fcntl.LOCK_EX)
        for attempt in range(20):
            have = part.stat().st_size if part.exists() else 0
            req = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})  # noqa: S310
            try:
                with (
                    urllib.request.urlopen(req, timeout=60) as r,  # noqa: S310 – stały adres https wydania
                    open(part, "ab" if have and r.status == 206 else "wb") as f,
                ):
                    while chunk := r.read(1 << 20):
                        f.write(chunk)
                break
            except OSError as e:
                log(f"wagi int8: pobieranie przerwane ({e}), próba {attempt + 1}")
                time.sleep(min(30, 2 + attempt))
        else:
            log("wagi int8: nie udało się pobrać – używam bf16")
            return None
        if _sha_file(part) != sha256:
            part.unlink(missing_ok=True)
            log("wagi int8: zła suma SHA-256 – używam bf16")
            return None
        part.replace(p)
        st = p.stat()
        mark.write_text(f"{sha256} {st.st_size} {int(st.st_mtime)}")
    return p


if __name__ == "__main__":
    from .qwen import SHA256 as SRC_SHA

    print(convert(Path(sys.argv[1]), Path(sys.argv[2]), SRC_SHA))
