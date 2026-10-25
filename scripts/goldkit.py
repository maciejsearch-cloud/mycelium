"""Odpowiedzi kontrolne (gold) bez przecieku: tajne ziarno, nowa runda identyfikatorów, zapis tylko poza repo.

Generatory pytań (export_qa_seed, export_captcha, export_lexicon, selfplay_run, zadania_run) losują pule pytań
z ziarna pochodnego od sekretu ``MYC_GOLD_SEED`` (HMAC-SHA256), więc z samego kodu nie da się odtworzyć,
które przykłady trafiły do puli ani w jakiej kolejności. Odpowiedzi kontrolne trafiają wyłącznie do
``.gold/<nazwa>.json`` (w .gitignore) i stamtąd – skryptem ``scripts/gold_rotate.py`` – do tabeli
``myc_gold`` (RLS, brak dostępu dla klientów). Pytania (bez odpowiedzi) zostają publiczne w web/public/data.

Runda (``ROUND``) wchodzi do identyfikatorów (litera po prefiksie rodzaju), więc stare, ujawnione odpowiedzi
nie pasują do nowych pytań. Długości identyfikatorów, po których strona grupuje (w… = 6 znaków słowa,
cg… = 7 znaków obrazu), są zachowane.

Uwaga (uczciwie): część pytań pochodzi z publicznych zbiorów z etykietami (Fashion-MNIST, CLINC150, WordNet,
NAB) albo jest sprawdzalna rozumowaniem (logika, matematyka) – tajność puli utrudnia skopiowanie klucza
odpowiedzi, ale nie uniemożliwia samodzielnego rozwiązania czy wyszukania przykładu w źródle.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GOLD_DIR = ROOT / ".gold"
ROUND = 2  # 1 = pierwsza (jawna w historii starego repo) pula; 2 = pierwsza pula z tajnym ziarnem
TAG = "abcdefghijklmnopqrstuvwxyz"[ROUND - 1]  # litera rundy w identyfikatorach („b” = runda 2)


def _secret() -> bytes:
    s = os.environ.get("MYC_GOLD_SEED", "")
    if len(s) < 16:
        raise SystemExit(
            "brak MYC_GOLD_SEED (≥16 znaków) – tajne ziarno puli pytań kontrolnych; bez niego generator nie "
            "nadpisze pytań (stare ziarna z kodu były jawne)"
        )
    return s.encode()


def seed(name: str) -> int:
    """Ziarno RNG dla generatora `name` (int 63-bit), pochodne od sekretu i rundy."""
    d = hmac.new(_secret(), f"{name}:r{ROUND}".encode(), hashlib.sha256).digest()
    return int.from_bytes(d[:8], "big") >> 1


def rid(prefix: str, n: int, width: int) -> str:
    """Identyfikator numeryczny z literą rundy: prefix + TAG + n na (width-1) cyfrach (ta sama długość co dawniej)."""
    if n >= 10 ** (width - 1):
        raise ValueError(f"{prefix}: {n} nie mieści się w {width - 1} cyfrach")
    return f"{prefix}{TAG}{n:0{width - 1}d}"


def hid(prefix: str, content_sha: str) -> str:
    """Identyfikator z treści (prefix + 8 znaków hex), solony rundą – ta sama treść w nowej rundzie = nowy id."""
    return prefix + hashlib.sha256(f"r{ROUND}:{content_sha}".encode()).hexdigest()[:8]


def write(name: str, rows: list[tuple[str, str]] | dict[str, str], source: str) -> Path:
    """Zapis odpowiedzi kontrolnych poza repo (.gold/, w .gitignore) – nigdy do supabase/*.sql."""
    items = sorted(rows.items()) if isinstance(rows, dict) else list(rows)
    ids = [q for q, _ in items]
    if len(ids) != len(set(ids)):
        raise ValueError(f"{name}: powtórzone identyfikatory")
    GOLD_DIR.mkdir(exist_ok=True)
    p = GOLD_DIR / f"{name}.json"
    p.write_text(
        json.dumps(
            {"round": ROUND, "source": source, "rows": [{"question_id": q, "answer": a} for q, a in items]},
            ensure_ascii=False,
        )
    )
    os.chmod(p, 0o600)
    return p
