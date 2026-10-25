"""Stały węzeł na PC: pierwsze uruchomienie, nadzorca (restart po awarii) i autostart po zalogowaniu.

    MyceliumNode.exe                 # Windows: dwuklik – pyta o wątki i autostart, potem działa
    python3 mycelium-node.pyz        # Linux / macOS: to samo w terminalu
    … --install [--threads 4] [--max-ram-gb 6]   # autostart: Windows (folder Autostart), systemd --user, launchd
    … --uninstall                    # usuwa autostart (pliki modelu zostają w pamięci podręcznej)

Nadzorca uruchamia właściwy węzeł jako proces potomny i wznawia go po awarii (5 s, 10 s, … maks. 5 min).
Ustawienia: <pamięć podręczna>/node-config.json. Panel (okno w stylu Vista, tylko ten komputer): MyceliumNode --ui.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

from .qwen import cache_dir

APP = "MyceliumNode"


def cfg_path() -> Path:
    return cache_dir() / "node-config.json"


def load_cfg() -> dict | None:
    with __import__("contextlib").suppress(OSError, ValueError):
        return json.loads(cfg_path().read_text())
    return None


def save_cfg(c: dict) -> None:
    cfg_path().parent.mkdir(parents=True, exist_ok=True)
    cfg_path().write_text(json.dumps(c, indent=1))


def self_cmd() -> list[str]:
    """Polecenie uruchamiające ten sam program (exe z PyInstallera, plik .pyz albo moduł)."""
    if getattr(sys, "frozen", False):
        return [sys.executable]
    a0 = os.path.abspath(sys.argv[0])
    if a0.endswith(".pyz"):
        return [sys.executable, a0]
    return [sys.executable, "-m", "iot_mycelium.node"]


def node_args(c: dict) -> list[str]:
    a = ["--join", "--name", c.get("name", "pc"), "--threads", str(c.get("threads", 2)), "--headless"]
    if c.get("max_ram_gb"):
        a += ["--max-ram-gb", str(c["max_ram_gb"])]
    if c.get("no_train"):
        a += ["--no-train"]
    return a


def default_cfg() -> dict:
    n = os.cpu_count() or 2
    return {"name": "pc", "threads": max(1, min(8, n // 2)), "max_ram_gb": 0, "no_train": False}


def ask(c: dict) -> dict:
    n = os.cpu_count() or 2
    print("\n🍄 Mycelium AI – węzeł na tym komputerze\n")
    print(f"Ten komputer ma {n} rdzeni logicznych. Węzeł działa z niskim priorytetem.")
    t = input(f"Ile wątków CPU oddać grzybni? [Enter = {c['threads']}]: ").strip()
    if t.isdigit() and 1 <= int(t) <= n:
        c["threads"] = int(t)
    r = (
        input("Limit RAM w GB (2–4 GB: wolniejszy trening, poniżej 2 GB tylko czat) [Enter = bez limitu]: ")
        .strip()
        .replace(",", ".")
    )
    with __import__("contextlib").suppress(ValueError):
        c["max_ram_gb"] = float(r) if r else 0
    auto = input("Uruchamiać węzeł automatycznie po zalogowaniu? [T/n]: ").strip().lower()
    c["autostart"] = auto not in ("n", "nie", "no")
    return c


# ---------------------------------------------------------------- autostart
def _startup_dir_win() -> Path:
    return Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def install(c: dict) -> str:
    sysname = platform.system()
    cmd = self_cmd()
    if sysname == "Windows":
        # kopia programu w %LOCALAPPDATA%\MyceliumNode (plik z Pobranych można potem usunąć)
        home = Path(os.environ.get("LOCALAPPDATA", Path.home())) / APP
        home.mkdir(parents=True, exist_ok=True)
        if getattr(sys, "frozen", False):
            dst = home / f"{APP}.exe"
            if Path(sys.executable).resolve() != dst.resolve():
                shutil.copy2(sys.executable, dst)
            cmd = [str(dst)]
        line = " ".join(f'"{x}"' for x in cmd)
        f = _startup_dir_win() / f"{APP}.cmd"
        f.write_text(f'@echo off\r\nstart "Mycelium AI" /min {line} --run\r\n', encoding="utf-8")
        return f"autostart: {f}"
    if sysname == "Darwin":
        p = Path.home() / "Library" / "LaunchAgents" / "ai.mycelium.node.plist"
        p.parent.mkdir(parents=True, exist_ok=True)
        args = "".join(f"<string>{x}</string>" for x in [*cmd, "--run"])
        log = cache_dir() / "node.log"
        p.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
            '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>'
            f"<key>Label</key><string>ai.mycelium.node</string><key>ProgramArguments</key><array>{args}</array>"
            "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Nice</key><integer>10</integer>"
            "<key>ProcessType</key><string>Background</string><key>LowPriorityIO</key><true/>"
            f"<key>StandardOutPath</key><string>{log}</string><key>StandardErrorPath</key><string>{log}</string>"
            "</dict></plist>\n"
        )
        subprocess.run(["launchctl", "unload", str(p)], capture_output=True)
        subprocess.run(["launchctl", "load", "-w", str(p)], check=False)
        return f"autostart: {p} (launchd)"
    # Linux: usługa systemd użytkownika
    p = Path.home() / ".config" / "systemd" / "user" / "mycelium-node.service"
    p.parent.mkdir(parents=True, exist_ok=True)
    mem = f"MemoryMax={c['max_ram_gb']}G\n" if c.get("max_ram_gb") else ""
    exe = " ".join(f'"{x}"' for x in [*cmd, "--run"])
    env = f"Environment=MYC_CACHE={cache_dir()}\n"
    p.write_text(
        "[Unit]\nDescription=Mycelium AI node\nAfter=network-online.target\n\n"
        f"[Service]\nExecStart={exe}\n{env}Restart=always\nRestartSec=10\nNice=10\nCPUWeight=20\n{mem}"
        "\n[Install]\nWantedBy=default.target\n"
    )
    if shutil.which("systemctl"):
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
        subprocess.run(["systemctl", "--user", "enable", "--now", "mycelium-node.service"], check=False)
        return f"autostart: {p} (systemd --user; start także bez logowania: sudo loginctl enable-linger {os.environ.get('USER', '')})"
    return f"zapisano {p}, ale brak systemctl – uruchom ręcznie: {exe}"


def uninstall() -> str:
    sysname = platform.system()
    if sysname == "Windows":
        f = _startup_dir_win() / f"{APP}.cmd"
        f.unlink(missing_ok=True)
        return f"usunięto {f}"
    if sysname == "Darwin":
        p = Path.home() / "Library" / "LaunchAgents" / "ai.mycelium.node.plist"
        subprocess.run(["launchctl", "unload", "-w", str(p)], capture_output=True)
        p.unlink(missing_ok=True)
        return f"usunięto {p}"
    p = Path.home() / ".config" / "systemd" / "user" / "mycelium-node.service"
    if shutil.which("systemctl"):
        subprocess.run(["systemctl", "--user", "disable", "--now", "mycelium-node.service"], check=False)
    p.unlink(missing_ok=True)
    return f"usunięto {p}"


# ---------------------------------------------------------------- panel
def _running_ui(name: str) -> int | None:
    """Port panelu węzła, który już działa na tym komputerze (sprawdzony zapytaniem), albo None."""
    import urllib.request

    from .dashboard import ui_info_path

    try:
        port = int(json.loads(ui_info_path(name).read_text())["port"])
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/status.json", timeout=3) as r:  # noqa: S310 – localhost
            json.loads(r.read())
        return port
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _open_when_ready(name: str, after: float, timeout: float = 120) -> None:
    """Czeka, aż węzeł potomny uruchomi panel (plik ui-<nazwa>.json), i otwiera okno."""
    from .dashboard import open_window, ui_info_path, ui_token, ui_url

    t0 = time.time()
    while time.time() - t0 < timeout:
        p = ui_info_path(name)
        with __import__("contextlib").suppress(OSError):
            if p.stat().st_mtime >= after - 1 and _running_ui(name):
                how = open_window(ui_url(_running_ui(name) or 8765, ui_token()))
                print(f"panel węzła otwarty ({how}); ponownie: MyceliumNode --ui")
                return
        time.sleep(1)


def open_ui(argv: list[str]) -> int:
    """--ui: otwiera panel działającego węzła; gdy nie działa – uruchamia aplikację (z oknem)."""
    from .dashboard import open_window, ui_token, ui_url

    c = load_cfg() or default_cfg()
    port = _running_ui(c.get("name", "pc"))
    if port:
        print(f"panel: {open_window(ui_url(port, ui_token()))}")
        return 0
    return run_app([x for x in argv if x != "--ui"])


# ---------------------------------------------------------------- nadzorca
def supervise(c: dict, window: bool = False) -> int:
    """Uruchamia węzeł jako proces potomny i wznawia go po awarii (narastająca przerwa, maks. 5 min).

    W wersji exe/binarnej co 6 h sprawdza podpisaną nową wersję (selfupdate); po podmianie nowa wersja musi działać
    3 min, inaczej powrót do starej i blokada wydania. Kod 75 = panel poprosił o restart (np. nowy limit RAM):
    start od razu, z ustawieniami odczytanymi na nowo. window=True: po starcie otwiera okno panelu."""
    import threading

    from . import selfupdate as su
    from .dashboard import RESTART_CODE

    delay = 5
    upd = su.enabled(c)
    exe = Path(sys.executable)
    blocked = set(c.get("blocked_releases", []))
    last_check = 0.0
    print(f"Mycelium AI: uruchamiam węzeł ({c['threads']} wątki). Panel otworzysz: MyceliumNode --ui  (Ctrl+C = stop)")
    if not upd and getattr(sys, "frozen", False):
        print("samoaktualizacja wyłączona")
    while True:
        c = load_cfg() or c
        cmd = [*self_cmd(), *node_args(c)]
        t0 = time.time()
        if window:
            threading.Thread(target=_open_when_ready, args=(c.get("name", "pc"), t0), daemon=True).start()
            window = False
        try:
            child = subprocess.Popen(cmd)
            while (rc := child.poll()) is None:
                time.sleep(5)
                if upd and time.time() - last_check > su.CHECK_EVERY_S:
                    last_check = time.time()
                    try:
                        got = su.fetch(exe, su.file_sha(exe), blocked)
                    except Exception as e:  # noqa: BLE001 – sieć: następna próba za 6 h
                        print(f"samoaktualizacja: {type(e).__name__}: {e}")
                        got = None
                    if got:
                        new, tag = got
                        print(f"samoaktualizacja: zweryfikowano {tag}, przełączam")
                        child.terminate()
                        child.wait(60)
                        old = su.swap(exe, new)
                        child = subprocess.Popen(cmd)
                        time.sleep(su.HEALTHY_AFTER_S)
                        if child.poll() is not None:
                            print(f"samoaktualizacja: {tag} nie wystartowała – powrót do poprzedniej wersji")
                            su.rollback(exe, old)
                            blocked.add(tag)
                            c["blocked_releases"] = sorted(blocked)
                            save_cfg(c)
                            child = subprocess.Popen(cmd)
                        else:
                            print(f"samoaktualizacja: działa {tag}")
            rc = child.returncode
        except KeyboardInterrupt:
            return 0
        if rc == 0:
            return 0
        if rc == RESTART_CODE:
            print("ponowny start węzła z nowymi ustawieniami")
            continue
        delay = 5 if time.time() - t0 > 600 else min(300, delay * 2)
        print(f"węzeł zakończył się kodem {rc}; ponowny start za {delay} s")
        try:
            time.sleep(delay)
        except KeyboardInterrupt:
            return 0


def run_app(argv: list[str]) -> int:
    """Dwuklik: ustawienia przy pierwszym starcie, nadzorca i okno panelu. --run (autostart): bez okna.
    --headless: nigdy nie otwiera okna (serwery). Gdy węzeł już działa – tylko otwiera jego panel."""
    c = load_cfg()
    first = c is None
    c = c or default_cfg()
    window = "--run" not in argv and "--headless" not in argv
    if window and _running_ui(c.get("name", "pc")):
        return open_ui(["--ui"])
    if first and sys.stdin and sys.stdin.isatty() and "--run" not in argv:
        c = ask(c)
        save_cfg(c)
        if c.get("autostart"):
            print(install(c))
    elif first:
        save_cfg(c)
    if "--no-self-update" in argv:
        c["no_self_update"] = True
        save_cfg(c)
    return supervise(c, window=window)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="mycelium-node")
    ap.add_argument("--install", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--threads", type=int)
    ap.add_argument("--max-ram-gb", type=float)
    ap.add_argument("--name")
    ap.add_argument("--no-train", action="store_true")
    ap.add_argument("--no-self-update", action="store_true", help="bez automatycznych aktualizacji programu")
    a = ap.parse_args(argv)
    if a.uninstall:
        print(uninstall())
        return 0
    c = load_cfg() or default_cfg()
    for k in ("threads", "max_ram_gb", "name"):
        if getattr(a, k) is not None:
            c[k] = getattr(a, k)
    if a.no_train:
        c["no_train"] = True
    if a.no_self_update:
        c["no_self_update"] = True
    c["autostart"] = True
    save_cfg(c)
    print(install(c))
    return 0
