"""Eksport zatwierdzonych wzorców języka z czatu globalnego (myc_lang_approved) jako odłamek danych LM.

Tylko dane (JSONL), tylko pozycje zatwierdzone w Weryfikuj (głosowanie lub złota etykieta Developera); treść już
wyczyszczona w bazie (bez pseudonimów, linków, e-maili, telefonów). Wynik: web/public/data/lm/patterns.jsonl
(+ sha256 w patterns.meta.json). Użycie: python scripts/export_patterns.py [--room main]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "data" / "lm"
SB_URL = "https://agortpieeygmcttjwjfx.supabase.co"
SB_KEY = "sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P"  # klucz publikowalny (publiczny z założenia, RLS w bazie)

PROMPT = {
    "skrót": ("Co znaczy w czacie „{p}”?", "„{p}” to {l}."),
    "emotikon": ("Co wyraża „{p}” w wiadomości?", "„{p}” to {l}."),
    "wydłużenie": ("Dlaczego ktoś pisze „{p}”?", "To {l}."),
    "intencja": ("Jaka to intencja: „{p}”?", "To {l}."),
    "ironia": ("Czy to ironia: „{p}”?", "Tak – {l}."),
}


def fetch(room: str) -> list[dict]:
    url = f"{SB_URL}/rest/v1/myc_lang_approved?select=id,kind,pattern,label,decided_by&room=eq.{room}&order=id&limit=10000"
    req = urllib.request.Request(url, headers={"apikey": SB_KEY})  # noqa: S310 – stały adres https
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 – stały adres https
        return json.load(r)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--room", default="main", choices=["main", "e2e"])
    a = ap.parse_args()
    rows = fetch(a.room)
    OUT.mkdir(parents=True, exist_ok=True)
    lines = []
    for r in rows:
        q, ans = PROMPT.get(r["kind"], ("„{p}”?", "{l}"))
        lines.append(
            json.dumps(
                {
                    "id": r["id"],
                    "kind": r["kind"],
                    "prompt": q.format(p=r["pattern"]),
                    "answer": ans.format(p=r["pattern"], l=r["label"]),
                    "gold": r["decided_by"] == "owner",
                },
                ensure_ascii=False,
            )
        )
    body = ("\n".join(lines) + "\n") if lines else ""
    (OUT / "patterns.jsonl").write_text(body, encoding="utf-8")
    meta = {
        "n": len(lines),
        "sha256": hashlib.sha256(body.encode()).hexdigest(),
        "source": "myc_lang_approved",
        "room": a.room,
    }
    (OUT / "patterns.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wzorce: {len(lines)} → {OUT / 'patterns.jsonl'}")


if __name__ == "__main__":
    main()
