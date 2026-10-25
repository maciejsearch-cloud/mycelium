"""Samoaktualizacja węzła PC (etap S5): tylko podpisane wydania z maciejsearch-cloud/demo, z powrotem do starej wersji.

Zasady (fail-closed – każda wątpliwość = brak aktualizacji):
1. Manifest `node/binaries.json` ze strony demo; test dymny („smoke”) musi być „ok” na każdym systemie.
2. Jeśli manifest ma sekcję „gate” (metryki etapów), wydanie przechodzi tylko, gdy żadna metryka nie jest gorsza,
   a co najmniej jedna jest lepsza (nie próg 100%). Modele węzeł i tak bierze wyłącznie z `myc_models` (po bramce).
3. Podpis Sigstore pliku SHA256SUMS.txt (tożsamość: workflow wydania w repozytorium demo, wystawca GitHub Actions),
   suma pliku w SHA256SUMS.txt = suma w manifeście = suma pobranego pliku. Brak biblioteki sigstore = brak aktualizacji.
4. Podmiana atomowa: nowy plik obok (`.new`), stary zostaje jako `.old`; gdy nowa wersja nie wystartuje → powrót
   i blokada tego wydania. Wyłączenie: `--no-self-update` albo MYC_NO_SELF_UPDATE=1.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
import urllib.request
from pathlib import Path

MANIFEST_URL = "https://maciejsearch-cloud.github.io/demo/mycelium/node/binaries.json"
RELEASE_PREFIX = "https://github.com/maciejsearch-cloud/demo/releases/download/"
IDENTITY = "https://github.com/maciejsearch-cloud/demo/.github/workflows/mycelium-node-build.yml@refs/heads/main"
ISSUER = "https://token.actions.githubusercontent.com"
CHECK_EVERY_S = 6 * 3600
HEALTHY_AFTER_S = 180
UA = "MyceliumNode/2 (+https://maciejsearch-cloud.github.io/demo/mycelium/)"


def enabled(cfg: dict) -> bool:
    return (
        bool(getattr(sys, "frozen", False))
        and not cfg.get("no_self_update")
        and os.environ.get("MYC_NO_SELF_UPDATE", "") not in ("1", "true", "yes")
    )


def os_key() -> str:
    """Klucz pliku w binaries.json; wariant DirectML aktualizuje się tylko do wariantu DirectML."""
    s = platform.system().lower()
    k = "windows" if s.startswith("win") else "macos" if s == "darwin" else "linux"
    import importlib.util

    with __import__("contextlib").suppress(Exception):
        if k == "windows" and importlib.util.find_spec("torch_directml") is not None:
            return "windows-directml"
    return k


def gate_ok(gate: dict | None) -> bool:
    """{etap: {"prev": x, "new": y, "higher": True}} → żadna gorsza i co najmniej jedna lepsza; brak sekcji = True."""
    if not gate:
        return True
    better = False
    for g in gate.values():
        prev, new, hi = float(g["prev"]), float(g["new"]), bool(g.get("higher", True))
        if (new < prev) if hi else (new > prev):
            return False
        better |= (new > prev) if hi else (new < prev)
    return better


def sums_lookup(sums: str, name: str) -> str | None:
    for line in sums.splitlines():
        p = line.split()
        if len(p) == 2 and p[1].lstrip("*") == name and len(p[0]) == 64:
            return p[0].lower()
    return None


def file_sha(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def _get(url: str, timeout=120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})  # noqa: S310 – stałe adresy https
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
        return r.read()


def signature_lib_ok() -> bool:
    try:
        from sigstore.models import Bundle  # noqa: F401
        from sigstore.verify import Verifier, policy  # noqa: F401
    except ImportError:
        return False
    return True


def verify_signature(sums: bytes, bundle_json: bytes) -> bool:
    try:
        from sigstore.models import Bundle
        from sigstore.verify import Verifier, policy
    except ImportError:
        return False
    try:
        Verifier.production().verify_artifact(
            sums, Bundle.from_json(bundle_json), policy.Identity(identity=IDENTITY, issuer=ISSUER)
        )
        return True
    except Exception:  # noqa: BLE001 – każdy błąd weryfikacji = brak aktualizacji
        return False


def plan(manifest: dict, own_sha: str, blocked: set[str]) -> tuple[dict | None, str]:
    """Wybór pliku do aktualizacji bez sieci: (plik, powód)."""
    tag = str(manifest.get("tag", ""))
    f = next((x for x in manifest.get("files", []) if x.get("os") == os_key()), None)
    if f is None:
        return None, "brak pliku dla tego systemu"
    if f.get("sha256") == own_sha:
        return None, "aktualna wersja"
    if tag in blocked:
        return None, f"wydanie {tag} zablokowane (nieudany start)"
    if not str(f.get("url", "")).startswith(RELEASE_PREFIX + tag + "/"):
        return None, "adres spoza wydań repozytorium demo"
    smoke = manifest.get("smoke") or {}
    if not smoke or not all(str(v).startswith("ok") for v in smoke.values()):
        return None, "test dymny nie przeszedł na wszystkich systemach"
    if not gate_ok(manifest.get("gate")):
        return None, "bramka etapów: któraś metryka gorsza albo żadna lepsza"
    return f, "ok"


def fetch(exe: Path, own_sha: str, blocked: set[str], log=print) -> tuple[Path, str] | None:
    """Pobiera i weryfikuje nową wersję do `<exe>.new`; zwraca (ścieżka, tag) albo None."""
    m = json.loads(_get(MANIFEST_URL, 60))
    f, why = plan(m, own_sha, blocked)
    if f is None:
        if why != "aktualna wersja":
            log(f"samoaktualizacja: pominięta – {why}")
        return None
    tag = m["tag"]
    sums = _get(RELEASE_PREFIX + tag + "/SHA256SUMS.txt")
    bundle = _get(RELEASE_PREFIX + tag + "/SHA256SUMS.txt.sigstore.json")
    if not verify_signature(sums, bundle):
        log("samoaktualizacja: podpis Sigstore niepoprawny albo niedostępny – pominięta")
        return None
    if sums_lookup(sums.decode(), f["name"]) != f["sha256"]:
        log("samoaktualizacja: suma w SHA256SUMS.txt różni się od manifestu – pominięta")
        return None
    new = exe.with_name(exe.name + ".new")
    req = urllib.request.Request(f["url"], headers={"User-Agent": UA})  # noqa: S310
    h = hashlib.sha256()
    with urllib.request.urlopen(req, timeout=600) as r, open(new, "wb") as out:  # noqa: S310
        for b in iter(lambda: r.read(1 << 20), b""):
            h.update(b)
            out.write(b)
    if h.hexdigest() != f["sha256"]:
        new.unlink(missing_ok=True)
        log("samoaktualizacja: suma pobranego pliku się nie zgadza – pominięta")
        return None
    return new, tag


def swap(exe: Path, new: Path) -> Path:
    """Atomowa podmiana: exe → exe.old, new → exe. Zwraca ścieżkę starej wersji."""
    old = exe.with_name(exe.name + ".old")
    if old.exists():
        old.unlink()
    os.replace(exe, old)
    os.replace(new, exe)
    if os.name != "nt":
        os.chmod(exe, 0o700)
    return old


def rollback(exe: Path, old: Path) -> None:
    bad = exe.with_name(exe.name + ".bad")
    if bad.exists():
        bad.unlink()
    os.replace(exe, bad)
    os.replace(old, exe)
