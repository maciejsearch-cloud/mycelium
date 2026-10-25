"""Opcjonalne obliczenia na GPU: DirectML (Windows, karty AMD/Intel/NVIDIA) w osobnym wariancie węzła.

Domyślny plik wykonywalny liczy na CPU (mały, PyTorch CPU). Wariant MyceliumNode-DirectML.exe zawiera torch-directml
(PyTorch 2.4.1). GPU włącza się tylko po teście na tym komputerze (benchmark()): ten sam krok treningu LoRA na CPU
i na DirectML (te same dane, ten sam adapter startowy, kilka warstw modelu + pełna warstwa wyjściowa), GPU musi być
szybsze ORAZ dawać tę samą stratę (różnica względna ≤ 2%, wartości skończone). Wynik testu (prędkości obu,
różnica strat) zapisany w <pamięć podręczna>/gpu-bench.json i pokazany w panelu. Wynik treningu i tak przechodzi
niezależną ocenę f32 i bramkę bez regresji – GPU zmienia tylko to, gdzie liczy się krok treningu.
"""

from __future__ import annotations

import contextlib
import json
import time

import torch

from .qwen import cache_dir

BENCH_LAYERS = 4
LOSS_TOL = 0.02
BENCH_VERSION = 1


_DML_ERR = ""


def dml_available() -> bool:
    global _DML_ERR
    try:
        import torch_directml  # type: ignore

        if torch_directml.is_available() and torch_directml.device_count() > 0:
            _DML_ERR = ""
            return True
        _DML_ERR = "torch-directml nie widzi zgodnej karty (DirectX 12)"
    except Exception as e:  # noqa: BLE001 – np. brak biblioteki DLL w pliku wykonywalnym: pokazujemy powód
        _DML_ERR = f"{type(e).__name__}: {str(e)[:200]}"
    return False


def dml_error() -> str:
    """Dlaczego DirectML niedostępny (pusty, gdy dostępny albo nie sprawdzano)."""
    return _DML_ERR


def dml_installed() -> bool:
    import importlib.util

    with contextlib.suppress(Exception):
        return importlib.util.find_spec("torch_directml") is not None
    return False


def dml_device():
    import torch_directml  # type: ignore

    return torch_directml.device(torch_directml.default_device())


def dml_name() -> str | None:
    with contextlib.suppress(Exception):
        import torch_directml  # type: ignore

        return str(torch_directml.device_name(torch_directml.default_device()))
    return None


class DevModel:
    """Kopia wag modelu (lub pierwszych `layers` warstw) na urządzeniu `dev` w typie `dtype` – tylko do treningu."""

    def __init__(self, m, dev, dtype, layers: int | None = None):
        mv = (lambda t: t.to(dev, dtype)) if dev is not None else (lambda t: t.to(dtype))
        self.dtype = dtype
        self.emb = mv(m.emb)
        self.norm = mv(m.norm)
        self.L = [{k: mv(v) for k, v in L.items()} for L in (m.L if layers is None else m.L[:layers])]
        self.cos, self.sin = mv(m.cos), mv(m.sin)

    def full_bytes(self) -> int:
        """Pamięć pełnego modelu (24 warstwy) w tym typie – do oceny, czy zmieści się w pamięci GPU/RAM."""
        from .qwen import LAYERS

        b = lambda x: x.numel() * x.element_size()  # noqa: E731
        layer = sum(b(v) for v in self.L[0].values())
        return b(self.emb) + b(self.norm) + b(self.cos) + b(self.sin) + layer * LAYERS


def bench_path():
    return cache_dir() / "gpu-bench.json"


def load_bench() -> dict | None:
    with contextlib.suppress(OSError, ValueError):
        b = json.loads(bench_path().read_text())
        if b.get("v") == BENCH_VERSION:
            return b
    return None


def _steps(model, dev, ids, mask, steps: int) -> tuple[list[float], float]:
    from . import lm

    tr = lm.Trainer(model, lm.Lora.init(0), ids, mask, batch=ids.shape[0], lr=1e-3, seed=0, device=dev)
    losses, times = [], []
    for _ in range(steps):
        t0 = time.perf_counter()
        losses.append(tr.step())
        times.append(time.perf_counter() - t0)
    return losses, min(times[1:]) if len(times) > 1 else times[0]


def benchmark(m, ids, mask, steps: int = 3, log=print) -> dict:
    """CPU (wagi węzła, bez kopii) vs DirectML (kopia f16, potem f32 gdy f16 niezgodne) na BENCH_LAYERS warstwach."""
    res: dict = {"v": BENCH_VERSION, "at": time.time(), "layers": BENCH_LAYERS, "steps": steps, "seq": list(ids.shape)}
    res["torch"] = torch.__version__
    res["adapter"] = dml_name()
    cpu_m = DevModel(m, None, m.dtype, BENCH_LAYERS)
    cl, ct = _steps(cpu_m, None, ids, mask, steps)
    res["cpu"] = {"dtype": str(m.dtype).replace("torch.", ""), "s_per_step": round(ct, 4), "loss0": round(cl[0], 6)}
    del cpu_m
    res["ok"] = False
    if not dml_available():
        res["reason"] = (
            f"DirectML niedostępny: {dml_error()}"
            if dml_installed()
            else "brak DirectML (torch-directml) w tej wersji węzła"
        )
        _save(res)
        return res
    try:
        dev = dml_device()
    except Exception as e:  # noqa: BLE001
        res["reason"] = f"DirectML nie uruchomił urządzenia: {type(e).__name__}: {str(e)[:200]}"
        _save(res)
        return res
    tried = []
    for dt in (torch.float16, torch.float32):
        r = {"dtype": str(dt).replace("torch.", "")}
        try:
            gm = DevModel(m, dev, dt, BENCH_LAYERS)
            gl, gt = _steps(gm, dev, ids, mask, steps)
            full_mb = round(gm.full_bytes() / 2**20)
            del gm
            rel = abs(gl[0] - cl[0]) / max(1e-6, abs(cl[0]))
            r.update(
                {
                    "s_per_step": round(gt, 4),
                    "loss0": round(gl[0], 6),
                    "loss_rel_diff": round(rel, 5),
                    "finite": all(x == x and abs(x) != float("inf") for x in gl),
                    "speedup": round(ct / gt, 3) if gt > 0 else None,
                    "approx_model_mb": full_mb,
                }
            )
            r["sane"] = r["finite"] and rel <= LOSS_TOL
            r["faster"] = gt < ct
        except Exception as e:  # noqa: BLE001 – brak operacji w DirectML itp.: uczciwie „nie działa”
            r["error"] = f"{type(e).__name__}: {str(e)[:200]}"
        tried.append(r)
        if r.get("sane"):
            break
    res["gpu"] = tried
    best = next((r for r in tried if r.get("sane")), None)
    if best is None:
        res["reason"] = "wynik na GPU niezgodny z CPU albo błąd operacji"
    elif not best["faster"]:
        res["reason"] = f"GPU wolniejsze od CPU ({best['s_per_step']} s vs {ct:.3f} s na krok)"
    else:
        res["ok"], res["dtype"] = True, best["dtype"]
    log(f"test GPU: {json.dumps(res, ensure_ascii=False)[:400]}")
    _save(res)
    return res


def _save(res: dict) -> None:
    with contextlib.suppress(OSError):
        bench_path().write_text(json.dumps(res, indent=1))
