"""Pomiar zasobów węzła (prawdziwe odczyty, bez szacunków): CPU systemu i procesu, RAM, GPU.

CPU/RAM: psutil (wbudowany w pliki wykonywalne); bez psutil: /proc (Linux) albo GetSystemTimes (Windows);
w innych przypadkach tylko CPU tego procesu (time.process_time). GPU: NVIDIA przez nvidia-smi (sterownik),
inne karty: „nie wykryto” – nic nie zgadujemy. Obliczenia na GPU zgłasza capabilities() uczciwie.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

try:  # psutil jest w plikach wykonywalnych; w .pyz opcjonalny
    import psutil  # type: ignore
except ImportError:  # pragma: no cover - zależy od środowiska
    psutil = None

NCPU = os.cpu_count() or 1


def _proc_stat() -> tuple[float, float] | None:
    with contextlib.suppress(OSError, ValueError, IndexError):
        with open("/proc/stat") as f:
            v = [float(x) for x in f.readline().split()[1:]]
        idle = v[3] + (v[4] if len(v) > 4 else 0)
        return sum(v), idle
    return None


def _win_times() -> tuple[float, float] | None:
    if os.name != "nt":
        return None
    with contextlib.suppress(Exception):
        import ctypes

        class FT(ctypes.Structure):
            _fields_ = [("lo", ctypes.c_uint32), ("hi", ctypes.c_uint32)]

        i, k, u = FT(), FT(), FT()
        if ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(i), ctypes.byref(k), ctypes.byref(u)):
            f = lambda t: (t.hi << 32 | t.lo) / 1e7  # noqa: E731
            return f(k) + f(u), f(i)  # czas jądra zawiera bezczynność
    return None


def _mem() -> dict:
    if psutil:
        vm = psutil.virtual_memory()
        rss = psutil.Process().memory_info().rss
        return {"ram_total": vm.total, "ram_used": vm.total - vm.available, "ram_proc": rss}
    out: dict = {}
    with contextlib.suppress(OSError, ValueError):
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.split()[0]) * 1024
        out = {"ram_total": info["MemTotal"], "ram_used": info["MemTotal"] - info.get("MemAvailable", 0)}
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    out["ram_proc"] = int(line.split()[1]) * 1024
    return out


_SMI = None


def nvidia_smi() -> list[dict]:
    """Karty NVIDIA z nvidia-smi (nazwa, użycie %, pamięć). Pusta lista = brak sterownika/karty."""
    global _SMI
    if _SMI is None:
        _SMI = shutil.which("nvidia-smi") or ""
    if not _SMI:
        return []
    try:
        r = subprocess.run(
            [_SMI, "--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return []
    out = []
    for line in r.stdout.strip().splitlines():
        p = [x.strip() for x in line.split(",")]
        if len(p) == 4:
            with contextlib.suppress(ValueError):
                out.append({"name": p[0], "util": float(p[1]), "mem_used": float(p[2]), "mem_total": float(p[3])})
    return out


# ---------------------------------------------------------------- karty graficzne poza NVIDIA
_ADAPTERS: list[dict] | None = None
_NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _run(cmd: list[str], timeout: float = 15) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=_NOWIN).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _vendor(name: str) -> str:
    n = name.lower()
    for k, v in (
        ("nvidia", "NVIDIA"),
        ("geforce", "NVIDIA"),
        ("amd", "AMD"),
        ("radeon", "AMD"),
        ("intel", "Intel"),
        ("apple", "Apple"),
    ):
        if k in n:
            return v
    return ""


def _parse_wmi(raw: str) -> list[dict]:
    """JSON z Get-CimInstance Win32_VideoController → lista kart (bez wirtualnych „Basic Display”/pulpitu zdalnego)."""
    out: list[dict] = []
    with contextlib.suppress(ValueError):
        j = json.loads(raw) if raw.strip() else []
        for a in [j] if isinstance(j, dict) else j:
            name = str(a.get("Name") or "").strip()
            if not name or "basic display" in name.lower() or "remote" in name.lower():
                continue
            ram = a.get("AdapterRAM")
            out.append(
                {
                    "name": name,
                    "vendor": _vendor(name),
                    "driver": a.get("DriverVersion"),
                    # AdapterRAM to 32-bitowe pole WMI (maks. 4 GB); dla zintegrowanych = pamięć zarezerwowana
                    "vram_mb": round(ram / 2**20) if isinstance(ram, int) and ram > 0 else None,
                    "source": "WMI Win32_VideoController",
                }
            )
    return out


def adapters() -> list[dict]:
    """Karty graficzne systemu (raz na uruchomienie): Windows – WMI Win32_VideoController (PowerShell),
    Linux – /sys/class/drm, macOS – system_profiler. Nazwy prosto z systemu; bez zgadywania."""
    global _ADAPTERS
    if _ADAPTERS is not None:
        return _ADAPTERS
    out: list[dict] = []
    if os.name == "nt":
        ps = shutil.which("powershell") or shutil.which("pwsh")
        if ps:
            raw = _run(
                [
                    ps,
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,PNPDeviceID"
                    " | ConvertTo-Json -Compress",
                ]
            )
            out = _parse_wmi(raw)
    elif sys.platform == "darwin":
        with contextlib.suppress(ValueError):
            j = json.loads(_run(["system_profiler", "SPDisplaysDataType", "-json"]) or "{}")
            for a in j.get("SPDisplaysDataType", []):
                name = str(a.get("sppci_model") or a.get("_name") or "").strip()
                if name:
                    out.append({"name": name, "vendor": _vendor(name), "source": "system_profiler"})
    else:
        ids = {"0x1002": "AMD", "0x10de": "NVIDIA", "0x8086": "Intel"}
        for card in sorted(Path("/sys/class/drm").glob("card[0-9]")):
            dev = card / "device"
            with contextlib.suppress(OSError):
                v = (dev / "vendor").read_text().strip()
                name = ids.get(v, v)
                with contextlib.suppress(OSError):
                    name = f"{name} {(dev / 'product_name').read_text().strip()}"
                out.append(
                    {"name": name, "vendor": ids.get(v, ""), "source": f"/sys/class/drm/{card.name}", "_dev": str(dev)}
                )
    _ADAPTERS = out
    return out


class _WinGpuCounter:
    """Użycie GPU na Windows z liczników wydajności „GPU Engine(*) → Utilization Percentage” (PDH, angielska nazwa
    licznika – działa też w polskim Windows). Wynik: maks. suma silników jednego typu (3D, Compute…) w %."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        self.ct, self.wt = ctypes, wintypes
        self.pdh = ctypes.WinDLL("pdh.dll")
        self.q = wintypes.HANDLE()
        self.c = wintypes.HANDLE()
        if self.pdh.PdhOpenQueryW(None, None, ctypes.byref(self.q)) != 0:
            raise OSError("PdhOpenQuery")
        path = "\\GPU Engine(*)\\Utilization Percentage"
        if self.pdh.PdhAddEnglishCounterW(self.q, ctypes.c_wchar_p(path), None, ctypes.byref(self.c)) != 0:
            raise OSError("brak licznika GPU Engine")
        self.pdh.PdhCollectQueryData(self.q)

    def read(self) -> float | None:
        ct, wt = self.ct, self.wt

        class FMT(ct.Structure):
            _fields_ = [("CStatus", wt.DWORD), ("pad", wt.DWORD), ("doubleValue", ct.c_double)]

        class ITEM(ct.Structure):
            _fields_ = [("szName", ct.c_wchar_p), ("FmtValue", FMT)]

        if self.pdh.PdhCollectQueryData(self.q) != 0:
            return None
        size, count = wt.DWORD(0), wt.DWORD(0)
        PDH_FMT_DOUBLE, MORE = 0x200, 0x800007D2
        r = self.pdh.PdhGetFormattedCounterArrayW(self.c, PDH_FMT_DOUBLE, ct.byref(size), ct.byref(count), None)
        if r & 0xFFFFFFFF != MORE or not size.value:
            return None
        buf = (ct.c_byte * size.value)()
        r = self.pdh.PdhGetFormattedCounterArrayW(self.c, PDH_FMT_DOUBLE, ct.byref(size), ct.byref(count), buf)
        if r != 0:
            return None
        items = ct.cast(buf, ct.POINTER(ITEM))
        by: dict[str, float] = {}
        for i in range(count.value):
            it = items[i]
            name = it.szName or ""
            typ = name.rsplit("engtype_", 1)[-1] if "engtype_" in name else "?"
            by[typ] = by.get(typ, 0.0) + max(0.0, it.FmtValue.doubleValue)
        return round(min(100.0, max(by.values())), 1) if by else None


_WIN_CTR = None
_WIN_CTR_ERR = ""


def gpu_util_other() -> float | None:
    """Użycie GPU bez nvidia-smi: Windows (liczniki PDH), Linux AMD (gpu_busy_percent). None = brak odczytu."""
    global _WIN_CTR, _WIN_CTR_ERR
    if os.name == "nt":
        if _WIN_CTR is None and not _WIN_CTR_ERR:
            try:
                _WIN_CTR = _WinGpuCounter()
            except Exception as e:  # noqa: BLE001 – brak liczników = uczciwie „brak odczytu”
                _WIN_CTR_ERR = f"{type(e).__name__}: {e}"
        if _WIN_CTR is not None:
            with contextlib.suppress(Exception):
                return _WIN_CTR.read()
        return None
    for a in adapters():
        p = a.get("_dev")
        if p:
            with contextlib.suppress(OSError, ValueError):
                return float(Path(p, "gpu_busy_percent").read_text())
    return None


def capabilities() -> dict:
    """Co węzeł naprawdę potrafi policzyć: CPU zawsze; GPU tylko gdy PyTorch ma CUDA (pliki wykonywalne: CPU)."""
    cuda = False
    name = None
    with contextlib.suppress(Exception):
        import torch

        cuda = bool(torch.cuda.is_available())
        if cuda:
            name = torch.cuda.get_device_name(0)
    dml = False
    with contextlib.suppress(Exception):
        import importlib.util

        dml = importlib.util.find_spec("torch_directml") is not None
    torch_ver = None
    with contextlib.suppress(Exception):
        import torch

        torch_ver = torch.__version__
    return {
        "cpu_threads": NCPU,
        "torch_cuda": cuda,
        "torch_cuda_name": name,
        "torch_directml": dml,
        "psutil": psutil is not None,
        "torch": torch_ver,
        "variant": "directml" if dml else "cpu",
    }


class Monitor:
    """Próbki co `every` s (domyślnie 2 s), bufor ostatnich 15 min."""

    def __init__(self, every: float = 2.0, keep: int = 450):
        self.every = every
        self.samples: deque[dict] = deque(maxlen=keep)
        self._sys = None
        self._proc = (time.monotonic(), time.process_time())
        self._gpu_at = 0.0
        self._gpu: list[dict] = []
        self.other_util: float | None = None
        if psutil:
            psutil.cpu_percent(None)

    def _cpu(self) -> tuple[float | None, float]:
        now, pt = time.monotonic(), time.process_time()
        t0, p0 = self._proc
        self._proc = (now, pt)
        proc = max(0.0, min(100.0, (pt - p0) / max(1e-6, now - t0) / NCPU * 100))
        if psutil:
            return psutil.cpu_percent(None), proc
        cur = _proc_stat() or _win_times()
        sys_pct = None
        if cur and self._sys:
            dt, di = cur[0] - self._sys[0], cur[1] - self._sys[1]
            if dt > 0:
                sys_pct = max(0.0, min(100.0, (1 - di / dt) * 100))
        self._sys = cur
        return sys_pct, proc

    def sample(self) -> dict:
        sys_pct, proc = self._cpu()
        if time.monotonic() - self._gpu_at > 4:  # nvidia-smi rzadziej (to osobny proces)
            self._gpu_at = time.monotonic()
            self._gpu = nvidia_smi()
        s = {"t": time.time(), "cpu": sys_pct, "cpu_proc": round(proc, 1), **_mem()}
        if self._gpu:
            s["gpu"] = max(g["util"] for g in self._gpu)
        else:
            u = gpu_util_other()
            if u is not None:
                s["gpu"] = u
                self.other_util = u
        self.samples.append(s)
        return s

    def gpus(self) -> list[dict]:
        """NVIDIA (nvidia-smi: użycie i pamięć) albo karty z systemu (nazwa; użycie z liczników, gdy są)."""
        if self._gpu:
            return [{**g, "vendor": "NVIDIA", "source": "nvidia-smi"} for g in self._gpu]
        out = []
        for a in adapters():
            g = {k: v for k, v in a.items() if not k.startswith("_")}
            g["util"] = self.other_util
            g["util_source"] = (
                "liczniki Windows „GPU Engine”"
                if os.name == "nt" and self.other_util is not None
                else "gpu_busy_percent"
                if self.other_util is not None
                else None
            )
            out.append(g)
        return out

    @staticmethod
    def util_error() -> str:
        return _WIN_CTR_ERR
