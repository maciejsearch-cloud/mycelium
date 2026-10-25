"""Lokalny panel węzła w stylu Windows Vista (Aero): okno przeglądarki w trybie aplikacji, tylko 127.0.0.1.

Bez dodatkowych bibliotek okienkowych (plik wykonywalny zostaje mały, działa tak samo na Windows/Linux/macOS).
Dostęp: losowy klucz z <pamięć podręczna>/ui-token (prawa 0600) przekazywany w części # adresu – nie trafia do
dzienników serwera ani nagłówka Referer. Każde wywołanie /api/* wymaga nagłówka X-Myc-Token; serwer sprawdza też
nagłówek Host (ochrona przed DNS rebinding) i Origin przy zmianach. Panel nie widzi tokenów konta.
"""

from __future__ import annotations

import contextlib
import hmac
import json
import os
import platform
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from . import sched as schedmod
from .qwen import cache_dir
from .sysmon import capabilities

RESTART_CODE = 75  # węzeł prosi nadzorcę o ponowne uruchomienie (np. nowy limit RAM)


def token_path() -> Path:
    return cache_dir() / "ui-token"


def ui_token() -> str:
    p = token_path()
    with contextlib.suppress(OSError):
        t = p.read_text().strip()
        if len(t) >= 32:
            return t
    p.parent.mkdir(parents=True, exist_ok=True)
    t = secrets.token_urlsafe(32)
    tmp = p.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(t)
    os.replace(tmp, p)
    return t


def ui_info_path(name: str) -> Path:
    return cache_dir() / f"ui-{name}.json"


def ui_url(port: int, token: str) -> str:
    return f"http://127.0.0.1:{port}/ui#t={token}"


def _browser_app() -> list[str] | None:
    """Edge/Chrome/Chromium w trybie aplikacji (okno bez paska adresu); None = zwykła przeglądarka."""
    c: list[str] = []
    if os.name == "nt":
        for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                c += [
                    rf"{base}\Microsoft\Edge\Application\msedge.exe",
                    rf"{base}\Google\Chrome\Application\chrome.exe",
                ]
    elif sys.platform == "darwin":
        c += [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    else:
        for n in ("microsoft-edge", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
            w = shutil.which(n)
            if w:
                c.append(w)
    for x in c:
        if Path(x).exists():
            return [x]
    return None


def open_window(url: str) -> str:
    """Otwiera panel jako osobne okno (osobny profil przeglądarki: klucz nie trafia do historii głównej)."""
    app = _browser_app()
    if app:
        prof = cache_dir() / "ui-profile"
        with contextlib.suppress(OSError):
            subprocess.Popen(  # noqa: S603 – stała ścieżka przeglądarki, adres lokalny
                [*app, f"--app={url}", "--window-size=1180,820", f"--user-data-dir={prof}", "--no-first-run"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return "okno aplikacji"
    import webbrowser

    webbrowser.open(url)
    return "przeglądarka"


class Panel:
    """Stan i polecenia lokalnego panelu. Węzeł podpina się po załadowaniu modelu (attach)."""

    def __init__(self, name: str, node_id: str, base_alloc: dict, history, monitor, account, log=print):
        self.name, self.node_id, self.log = name, node_id, log
        self.base = base_alloc
        self.alloc, self.alloc_from_panel = schedmod.load(name, base_alloc)
        self.sched = schedmod.Scheduler(self.alloc)
        self.history, self.monitor, self.account = history, monitor, account
        self.node = None
        self.passive = None  # PassiveWorker (passive.py)
        self.bench_running = False
        self.bench_error = ""
        self.phase = "ładuję model…"
        self.lines: list[str] = []
        self.caps = capabilities()
        self.started = time.time()
        self.restart_req = threading.Event()
        self.applied_ram = float(self.alloc["ram_gb"])
        self._contrib: tuple[float, dict] | None = None

    def attach(self, node) -> None:
        self.node = node
        node.sched = self.sched
        self.phase = "działa"

    def line(self, s: str) -> None:
        self.lines.append(s)
        del self.lines[:-400]

    # ---------------------------------------------------------------- odczyt
    def state(self, since: float = 0) -> dict:
        st = self.node.status() if self.node else {"started": self.started, "connected": False}
        st["now"] = time.time()
        return {
            "phase": self.phase,
            "name": self.name,
            "host": platform.node(),
            "os": f"{platform.system()} {platform.release()}",
            "status": st,
            "alloc": self.alloc,
            "alloc_from_panel": self.alloc_from_panel,
            "restart_needed": float(self.alloc["ram_gb"]) != self.applied_ram,
            "kinds": schedmod.KINDS,
            "planned": schedmod.PLANNED,
            "sched": self.sched.view(),
            "caps": self.caps,
            "gpus": self.monitor.gpus(),
            "samples": [s for s in self.monitor.samples if s["t"] > since][-450:],
            "lines": self.lines[-200:],
            "account": self.account.view(),
            "passive": self.passive.view() if self.passive else None,
            "gpu": self.gpu_state(),
        }

    def contrib(self) -> dict:
        """Wkład tego węzła z bazy (publiczne widoki: myc_node_contrib, myc_results) + lokalny dziennik."""
        if self._contrib and time.time() - self._contrib[0] < 120:
            return self._contrib[1]
        from .net import SB_KEY, SB_URL

        def get(path):
            req = urllib.request.Request(f"{SB_URL}/rest/v1/{path}", headers={"apikey": SB_KEY})  # noqa: S310
            with urllib.request.urlopen(req, timeout=15) as r:  # noqa: S310 – stały adres https Supabase
                return json.loads(r.read())

        out: dict = {"local_daily": self.history.daily(14)}
        try:
            tot = get(f"myc_node_contrib?node_id=eq.{self.node_id}&select=*")
            out["total"] = tot[0] if tot else None
            since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 14 * 86400))
            rows = get(
                f"myc_results?node_id=eq.{self.node_id}&created_at=gte.{since}"
                "&select=created_at,kind,status,ms&order=created_at.desc&limit=2000"
            )
            days: dict[str, dict] = {}
            for r in rows:
                d = r["created_at"][:10]
                a = days.setdefault(d, {"day": d, "results": 0, "accepted": 0, "rejected": 0, "pending": 0, "h": 0.0})
                a["results"] += 1
                if r.get("status") in ("accepted", "rejected", "pending"):
                    a[r["status"]] += 1
                a["h"] += (r.get("ms") or 0) / 3.6e6
            out["daily"] = [days[k] for k in sorted(days)]
            out["source"] = "baza Supabase (myc_results tego węzła, 14 dni)"
        except Exception as e:  # noqa: BLE001 – brak sieci: pokazujemy tylko dziennik lokalny
            out["error"] = f"baza niedostępna: {type(e).__name__}"
        self._contrib = (time.time(), out)
        return out

    # ---------------------------------------------------------------- zmiany
    def set_alloc(self, body: dict) -> dict:
        merged = {
            **self.alloc,
            **body,
            "shares": {**self.alloc["shares"], **(body.get("shares") or {})},
            "passive": {**self.alloc.get("passive", {}), **(body.get("passive") or {})},
        }
        new = schedmod.sanitize(merged, self.base)
        msg = ""
        if new["gpu_on"] and not self.alloc.get("gpu_on"):
            ok, msg = self.gpu_can_enable()
            if not ok:
                new["gpu_on"] = False  # GPU tylko po udanym teście na tym komputerze i z miejscem w pamięci
        changed = {k: v for k, v in new.items() if self.alloc.get(k) != v}
        self.alloc.clear()
        self.alloc.update(new)
        self.alloc_from_panel = True
        schedmod.save(self.name, self.alloc)
        if "threads" in changed:
            with contextlib.suppress(Exception):
                import torch

                torch.set_num_threads(int(new["threads"]))
            if self.node:
                self.node.net.state["backend"] = f"cpu-torch-{new['threads']}t"
        if self.node and "compute_on" in changed:
            from .node import SHARDS

            # bez oddawania mocy węzeł nie przyjmuje rozmów (cap 0 w obecności), z mocą – cały model
            self.node.net.state["cap"] = len(SHARDS) if new["compute_on"] else 0
        _sync_service_cfg(new)
        if changed:
            self.history.add("settings", "zmieniono przydział mocy", changes=changed)
            self.log(f"przydział mocy: {json.dumps(changed, ensure_ascii=False)}")
        return {"alloc": self.alloc, "restart_needed": float(new["ram_gb"]) != self.applied_ram, "gpu_msg": msg}

    # ---------------------------------------------------------------- GPU
    def gpu_state(self) -> dict:
        from . import gpu

        b = gpu.load_bench()
        last = self.monitor.samples[-1] if self.monitor.samples else {}
        tot = last.get("ram_total")
        return {
            "directml": gpu.dml_available(),
            "dml_installed": gpu.dml_installed(),
            "dml_error": gpu.dml_error(),
            "dml_name": gpu.dml_name(),
            "bench": b,
            "bench_running": self.bench_running,
            "bench_error": self.bench_error,
            "util_error": self.monitor.util_error(),
            "note": getattr(getattr(self.node, "lmw", None), "gpu_note", "") if self.node else "",
            "backend": getattr(getattr(self.node, "lmw", None), "backend", "cpu") if self.node else "cpu",
            # propozycja limitu RAM dla komputerów z ≤ 8 GB (trening w mikro-paczkach, szczyt ok. 3 GB)
            "ram_suggest_gb": 3 if tot and tot <= 8.6 * 2**30 else None,
        }

    def gpu_can_enable(self) -> tuple[bool, str]:
        from . import gpu

        b = gpu.load_bench()
        if not gpu.dml_available():
            if gpu.dml_installed():
                return False, f"DirectML niedostępny na tym komputerze: {gpu.dml_error()}"
            return False, "Ta wersja węzła nie ma DirectML – pobierz wariant MyceliumNode-DirectML.exe."
        if not (b and b.get("ok")):
            return False, "Najpierw test GPU – GPU włączy się tylko, gdy jest szybsze od CPU i daje tę samą stratę."
        need = next((r.get("approx_model_mb") for r in b.get("gpu", []) if r.get("dtype") == b.get("dtype")), None)
        last = self.monitor.samples[-1] if self.monitor.samples else {}
        free = (last.get("ram_total") or 0) - (last.get("ram_used") or 0)
        if need and free and free < (need + 512) * 2**20:
            return (
                False,
                f"Za mało wolnej pamięci: model na GPU potrzebuje ok. {need} MB + zapas, wolne {free // 2**20} MB.",
            )
        return True, ""

    def gpu_bench(self) -> dict:
        """Uruchamia test CPU vs DirectML w tle (zadania wstrzymane na czas pomiaru, by CPU nie było obciążone)."""
        if self.bench_running or not self.node:
            return self.gpu_state()
        self.bench_running, self.bench_error = True, ""

        def run():
            from . import gpu

            try:
                self.sched.paused = True
                t0 = time.time()
                while self.sched.active and time.time() - t0 < 600:
                    time.sleep(1)  # czekamy na koniec bieżącego zadania (nie przerywamy go)
                lmw = getattr(self.node, "lmw", None)
                from .lmwork import Data

                ids, mask = (lmw.data if lmw else Data()).shard(0)
                r = gpu.benchmark(self.node.m, ids[:2], mask[:2], log=self.log)
                self.history.add(
                    "settings", f"test GPU: {'GPU szybsze i zgodne' if r.get('ok') else r.get('reason')}", bench=r
                )
            except Exception as e:  # noqa: BLE001
                self.bench_error = f"{type(e).__name__}: {str(e)[:200]}"
            finally:
                self.sched.paused = False
                self.bench_running = False

        threading.Thread(target=run, daemon=True).start()
        return self.gpu_state()

    def restart(self) -> dict:
        self.history.add("settings", "ponowne uruchomienie z panelu")
        self.restart_req.set()
        return {"ok": True}

    def account_op(self, op: str, body: dict) -> dict:
        from .account import AccountError

        try:
            if op == "create":
                v = self.account.create(str(body.get("handle", "")), str(body.get("ref", "")))
            elif op == "recover":
                v = self.account.recover(str(body.get("code", "")))
            elif op == "recovery_new":
                code = self.account.new_recovery()
                self.history.add("account", "konto: nowy kod odzyskiwania")
                return {**self.account.view(), "code": code}
            elif op == "logout":
                v = self.account.logout(bool(body.get("force")))
            elif op == "refresh":
                return self.account.refresh()
            else:
                return {"error": "nieznana operacja"}
            self.history.add("account", f"konto: {op}")
            return v
        except AccountError as e:
            self.history.add("account", f"konto: {op} – błąd: {e}")
            return {**self.account.view(), "error": str(e)}


def _sync_service_cfg(a: dict) -> None:
    """Ustawienia nadzorcy (node-config.json) zgodne z panelem, by restart użył tych samych wartości."""
    with contextlib.suppress(Exception):
        from .service import load_cfg, save_cfg

        c = load_cfg()
        if c is not None:
            c["threads"], c["max_ram_gb"] = int(a["threads"]), float(a["ram_gb"])
            save_cfg(c)


class Api:
    """Obsługa /ui i /api/* dla serwera ze status.py."""

    def __init__(self, panel: Panel, token: str):
        self.panel, self.token = panel, token
        self.port = 0

    def host_ok(self, host: str | None) -> bool:
        return host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}")

    def origin_ok(self, origin: str | None) -> bool:
        return origin in (None, "", f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}")

    def auth_ok(self, given: str | None) -> bool:
        return hmac.compare_digest((given or "").encode(), self.token.encode())

    def get(self, path: str, qs: dict) -> tuple[int, object]:
        p = self.panel
        q = lambda k, d="": (qs.get(k) or [d])[0]  # noqa: E731
        if path == "/api/state":
            with contextlib.suppress(ValueError):
                return 200, p.state(float(q("since", "0") or 0))
            return 200, p.state()
        if path == "/api/history":
            lim = int(q("limit", "300")) if q("limit", "300").isdigit() else 300
            return 200, p.history.query(q("q"), q("kind"), lim)
        if path == "/api/contrib":
            return 200, p.contrib()
        return 404, {"error": "not found"}

    def post(self, path: str, body: dict) -> tuple[int, object]:
        p = self.panel
        if path == "/api/alloc":
            return 200, p.set_alloc(body)
        if path == "/api/restart":
            return 200, p.restart()
        if path == "/api/gpu/bench":
            return 200, p.gpu_bench()
        if path.startswith("/api/account/"):
            return 200, p.account_op(path.rsplit("/", 1)[1], body)
        return 404, {"error": "not found"}


def page() -> str:
    from .ui_page import HTML

    return HTML


def logo() -> str:
    from .ui_page import LOGO

    return LOGO
