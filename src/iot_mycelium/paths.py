"""Wspólne ścieżki projektu.

Wcześniej każdy moduł używał ścieżek względnych typu ``../data/...``, więc wynik
zależał od katalogu, z którego uruchomiono program (np. ``streamlit run`` z
katalogu głównego zapisywał dane *poza* repozytorium). Teraz wszystko jest
liczone od katalogu projektu, a można to nadpisać zmienną środowiskową
``IOT_MYCELIUM_DATA_DIR``.
"""

from __future__ import annotations

import os
from pathlib import Path

_PACKAGE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _PACKAGE_DIR.parents[1]


def project_root() -> Path:
    """Katalog główny repozytorium (lub bieżący katalog, gdy pakiet jest zainstalowany)."""
    if (_REPO_ROOT / "pyproject.toml").exists():
        return _REPO_ROOT
    return Path.cwd()


def data_dir() -> Path:
    """Katalog na dane (pamięć grzybni, zapisani agenci, wyniki ewolucji)."""
    override = os.environ.get("IOT_MYCELIUM_DATA_DIR")
    path = Path(override) if override else project_root() / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def logs_dir() -> Path:
    """Katalog na wykresy i logi."""
    path = data_dir().parent / "logs" if os.environ.get("IOT_MYCELIUM_DATA_DIR") else project_root() / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def mycelium_path() -> Path:
    return data_dir() / "mycelium_memory.json"


def agents_dir() -> Path:
    path = data_dir() / "agents"
    path.mkdir(parents=True, exist_ok=True)
    return path


def evolution_dir() -> Path:
    path = data_dir() / "evolution"
    path.mkdir(parents=True, exist_ok=True)
    return path
