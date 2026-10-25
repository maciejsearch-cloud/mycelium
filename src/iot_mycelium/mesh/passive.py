"""Tryb pasywny (opcjonalny, osobny przełącznik w panelu): węzeł pomaga grzybni bez oddawania mocy CPU/GPU.

1. Sprawdzona pamięć podręczna (seeding, pierwszy etap): pobiera odłamki danych modelu językowego i pliki
   destylacji w granicach limitów dysku i dziennego transferu, każdy plik sprawdza sumą SHA-256 z manifestu
   projektu (meta.json / kd.json pobrane przez HTTPS z demo / wydania GitHub) i ogłasza w obecności, co ma
   (net.state["cache"]). Nie udostępnia plików innym (brak otwartych portów) – to późniejszy etap za zgodą.
2. Świadek: tanie sprawdzenia (bez treningu) – (a) wyniki treningu innych węzłów: adapter daje się odczytać,
   wartości skończone i w rozsądnym zakresie, FLOP = tokeny × 6·494e6, próbki = tokeny, prędkość możliwa dla
   deklarowanego sprzętu; (b) wydania węzła: podpis Sigstore SHA256SUMS.txt (gdy jest biblioteka sigstore – w plikach wykonywalnych), sumy SHA-256 w binaries.json (strona) zgodne z SHA256SUMS.txt
   (wydanie GitHub) i plik .pyz ze strony ma deklarowaną sumę. Wynik → myc_witness_report (jeden głos na węzeł
   i przedmiot, limit zapytań). Świadectwa są pomocnicze – nie zmieniają bramki ani punktów.

Wszystko liczone uczciwie: bajty pobrane dziś, miejsce na dysku, liczba sprawdzeń. Tylko dane (bez kodu).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import math
import os
import random
import time
import urllib.request
from pathlib import Path

from .qwen import cache_dir

SITE = os.environ.get("MYC_SITE", "https://maciejsearch-cloud.github.io/demo/mycelium/")
REPO_RELEASES = "https://github.com/maciejsearch-cloud/demo/releases/download/"
ALLOWED_HOSTS = ("https://maciejsearch-cloud.github.io/", "https://github.com/maciejsearch-cloud/demo/")
CPU_MAX_FLOPS = 5e13  # 50 TFLOP/s: nieosiągalne dla CPU/WASM (sprawdzenie „za szybko”)
PERIOD = float(os.environ.get("MYC_PASSIVE_PERIOD", "600"))


class Budget:
    """Licznik transferu na dobę (lokalny dzień) w <pamięć podręczna>/passive-usage.json."""

    def __init__(self, path: Path | None = None):
        self.path = path or cache_dir() / "passive-usage.json"
        self.u = {"day": "", "down": 0, "total_down": 0, "checks": 0, "flags": 0, "seeded": 0}
        with contextlib.suppress(OSError, ValueError):
            self.u.update(json.loads(self.path.read_text()))

    def _roll(self):
        d = time.strftime("%Y-%m-%d")
        if self.u["day"] != d:
            self.u["day"], self.u["down"] = d, 0

    def left(self, daily_gb: float) -> int:
        self._roll()
        return max(0, int(daily_gb * 2**30) - int(self.u["down"]))

    def add(self, key: str, n: int = 1):
        self._roll()
        self.u[key] = self.u.get(key, 0) + n
        if key == "down":
            self.u["total_down"] += n
        with contextlib.suppress(OSError):
            self.path.write_text(json.dumps(self.u))


def fetch(url: str, budget: Budget | None = None, limit: int | None = None, timeout: float = 120) -> bytes:
    if not url.startswith(ALLOWED_HOSTS):
        raise ValueError("niedozwolony adres")
    req = urllib.request.Request(url, headers={"User-Agent": "mycelium-node"})  # noqa: S310 – tylko adresy projektu
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
        n = int(r.headers.get("Content-Length") or 0)
        if limit is not None and n > limit:
            raise OverflowError("przekroczyłby dzienny limit transferu")
        b = r.read() if limit is None else r.read(limit + 1)
    if limit is not None and len(b) > limit:
        raise OverflowError("przekroczyłby dzienny limit transferu")
    if budget:
        budget.add("down", len(b))
    return b


def dir_bytes(p: Path) -> int:
    t = 0
    for f in p.rglob("*"):
        with contextlib.suppress(OSError):
            if f.is_file() and not f.is_symlink():
                t += f.stat().st_size
    return t


# ---------------------------------------------------------------- świadek: wynik treningu
def check_train_result(row: dict) -> dict:
    """Sprawdzenia spójności wyniku 'train' (bez treningu). Zwraca {"ok": bool, "checks": {...}}."""
    from . import lm

    c: dict = {}
    m = row.get("metrics") or {}
    tok = m.get("tokens")
    c["tokens_match"] = isinstance(tok, int) and tok > 0 and row.get("samples") == tok
    fl = float(row.get("flops") or 0)
    c["flops_match"] = bool(tok) and math.isclose(fl, tok * lm.FLOPS_TRAIN_TOKEN, rel_tol=0.01)
    ms = int(row.get("ms") or 0)
    c["speed_ok"] = ms > 0 and fl / (ms / 1000) <= CPU_MAX_FLOPS
    try:
        u = lm.Lora.from_bytes(base64.b64decode(row.get("payload") or "", validate=True))
        ts = u.tensors()
        c["adapter_ok"] = True
        c["finite"] = all(bool(t.isfinite().all()) for t in ts)
        mx = max(float(t.abs().max()) for t in ts)
        c["range_ok"] = c["finite"] and 0 < mx < 50
    except Exception:  # noqa: BLE001 – nieczytelny ładunek = flaga
        c["adapter_ok"] = c["finite"] = c["range_ok"] = False
    return {"ok": all(c.values()), "checks": c}


# ---------------------------------------------------------------- świadek: wydanie węzła
def check_release(budget: Budget | None = None) -> dict:
    """binaries.json (strona) ↔ SHA256SUMS.txt (wydanie GitHub) ↔ suma pliku .pyz ze strony."""
    import hashlib

    bj = json.loads(fetch(SITE + "node/binaries.json", budget))
    tag = str(bj.get("tag", ""))
    if not tag.startswith("node-") or "/" in tag:
        return {"subject": tag or "?", "ok": False, "checks": {"tag_ok": False}}
    sums = {}
    raw = fetch(f"{REPO_RELEASES}{tag}/SHA256SUMS.txt", budget)
    for line in raw.decode().splitlines():
        p = line.split()
        if len(p) == 2:
            sums[p[1].lstrip("*")] = p[0]
    c = {"tag_ok": True, "sums_listed": bool(sums), "sig_published": True}
    c["files_match"] = bool(bj.get("files")) and all(sums.get(f["name"]) == f["sha256"] for f in bj["files"])
    c["pyz_listed"] = sums.get("mycelium-node.pyz") == bj.get("pyz_sha256")
    try:
        bundle = fetch(f"{REPO_RELEASES}{tag}/SHA256SUMS.txt.sigstore.json", budget, limit=200_000)
    except Exception:  # noqa: BLE001
        bundle = None
        c["sig_published"] = False
    from . import selfupdate as su

    if bundle is not None and su.signature_lib_ok():
        # pełna weryfikacja Sigstore (tożsamość workflow wydania), jak przy samoaktualizacji
        c["sig_valid"] = su.verify_signature(raw, bundle)
    pyz = fetch(SITE + "node/mycelium-node.pyz", budget, limit=20 * 2**20)
    side = fetch(SITE + "node/mycelium-node.pyz.sha256", budget, limit=4096).decode().split()
    c["site_pyz_sha_ok"] = bool(side) and hashlib.sha256(pyz).hexdigest() == side[0]
    ok = all(c.values())
    # informacyjnie (nie flaga): nowszy .pyz na stronie, którego wydanie jeszcze się buduje
    c["site_pyz_is_release"] = hashlib.sha256(pyz).hexdigest() == bj.get("pyz_sha256")
    return {"subject": tag, "ok": ok, "checks": c}


class PassiveWorker:
    def __init__(self, node, panel, log=print):
        self.node, self.panel, self.log = node, panel, log
        self.budget = Budget()
        self.seen: set[str] = set()
        self.stats = {"cache_files": 0, "cache_bytes": 0, "witness_ok": 0, "witness_flag": 0, "last": None}
        self.last_error = ""

    @property
    def cfg(self) -> dict:
        return self.panel.alloc.get("passive") or {}

    def view(self) -> dict:
        b = self.budget
        b._roll()
        return {
            **self.stats,
            "down_today": b.u["down"],
            "down_total": b.u["total_down"],
            "checks_total": b.u["checks"],
            "flags_total": b.u["flags"],
            "seeded_total": b.u["seeded"],
            "disk_bytes": self.stats["cache_bytes"],
            "error": self.last_error,
        }

    # ---------------------------------------------------------------- seeding
    def seed(self) -> None:
        from .lmwork import KD_URL, Data

        cfg = self.cfg
        lim_disk = int(float(cfg.get("disk_gb", 2)) * 2**30)
        root = cache_dir() / "lm"
        root.mkdir(parents=True, exist_ok=True)
        files = []
        for base, meta in ((None, "meta.json"), (KD_URL, "kd.json")):
            d = Data() if base is None else Data(base, meta)
            with contextlib.suppress(Exception):
                mt = d.meta()
                files += [(d, f) for f in mt.get("files", []) if isinstance(f, dict)]
                if base is None and isinstance(mt.get("eval"), dict):
                    files.append((d, mt["eval"]))
        have, used = 0, dir_bytes(root)
        random.shuffle(files)
        fetched = 0
        for d, f in files:
            name, sha, size = f.get("name"), f.get("sha256"), int(f.get("bytes") or 0)
            p = root / str(name)
            if p.exists():
                have += 1
                continue
            if used + max(size, 1) > lim_disk or fetched >= 40:  # maks. 40 plików na rundę (łagodnie dla serwera)
                continue
            if self.budget.left(float(cfg.get("daily_gb", 1))) < max(size, 1):
                break
            try:
                before = p.exists()
                d.file(name, sha)  # pobranie + SHA-256 z manifestu (Data.file)
                if p.exists() and not before:
                    n = p.stat().st_size
                    self.budget.add("down", n)
                    self.budget.add("seeded")
                    used += n
                    have += 1
                    fetched += 1
            except Exception as e:  # noqa: BLE001
                self.last_error = f"seed: {type(e).__name__}"
        self.stats["cache_files"], self.stats["cache_bytes"] = have, used
        self.node.net.state["cache"] = {"lm_files": have, "bytes": used, "verified": "sha256"}

    # ---------------------------------------------------------------- świadek
    def _report(self, kind: str, subject: str, res: dict) -> None:
        sb = getattr(self.node.lmw, "sb", None)
        if sb is None:
            from .lmwork import Supa as SB

            sb = SB()
        sb.rpc(
            "myc_witness_report",
            {
                "p_node": self.node.id,
                "p_kind": kind,
                "p_subject": subject,
                "p_ok": res["ok"],
                "p_checks": res["checks"],
            },
        )
        self.budget.add("checks")
        self.stats["witness_ok" if res["ok"] else "witness_flag"] += 1
        if not res["ok"]:
            self.budget.add("flags")
        self.panel.history.add(
            "witness", f"świadek: {kind} {subject} – {'zgodne' if res['ok'] else 'FLAGA'}", checks=res["checks"]
        )

    def witness(self) -> None:
        from .lmwork import Supa as SB

        sb = getattr(self.node.lmw, "sb", None) or SB()
        if "rel" not in self.seen:
            with contextlib.suppress(Exception):
                r = check_release(self.budget)
                self._report("release", r["subject"], r)
                self.seen.add("rel")
        rows = sb.get(
            "myc_results?model=eq.lm&kind=eq.train&status=eq.pending&payload=not.is.null"
            f"&node_id=neq.{self.node.id}&select=id,payload,metrics,samples,flops,ms,backend,node_id&order=id.desc&limit=4"
        )
        for row in rows or []:
            key = f"r{row['id']}"
            if key in self.seen:
                continue
            self.seen.add(key)
            self.budget.add("down", len(row.get("payload") or ""))
            self._report("result", str(row["id"]), check_train_result(row))

    async def run(self, stop: asyncio.Event):
        await asyncio.sleep(random.uniform(10, 40))
        while not stop.is_set():
            cfg = self.cfg
            if cfg.get("on"):
                for name, fn in (("seed", self.seed), ("witness", self.witness)):
                    if not cfg.get(name, True):
                        continue
                    try:
                        await asyncio.to_thread(fn)
                        self.last_error = "" if name == "witness" else self.last_error
                    except Exception as e:  # noqa: BLE001 – sieć/baza: spróbuj później
                        self.last_error = f"{name}: {type(e).__name__}: {e}"[:200]
                self.stats["last"] = time.time()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), PERIOD if cfg.get("on") else 30)
