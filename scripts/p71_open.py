"""Tylko dla właściciela: odszyfrowanie trafienia Puzzle #71 (docs/puzzle71.md, „Procedura odbioru”).

Użycie: python scripts/p71_open.py <plik .sealed | id wiersza w myc_p71_hits> [--key ~/.secrets/p71/owner-x25519.key]
Sprawdza, że klucz daje adres zagadki, i zapisuje klucz prywatny (WIF, skompresowany) do pliku chmod 600.
Niczego nie wypisuje jawnie i niczego nie wysyła do sieci Bitcoin.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path

from iot_mycelium.mesh.p71 import TARGET_ADDRESS, core, seal


def wif(k: int) -> str:
    raw = b"\x80" + k.to_bytes(32, "big") + b"\x01"
    raw += hashlib.sha256(hashlib.sha256(raw).digest()).digest()[:4]
    n, s = int.from_bytes(raw, "big"), ""
    while n:
        n, r = divmod(n, 58)
        s = core.B58[r] + s
    return s


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--key", default="/workspace/.secrets/p71/owner-x25519.key")
    ap.add_argument("--out", default=str(Path.home() / "p71-claim.wif"))
    a = ap.parse_args()
    if Path(a.src).exists():
        ct = Path(a.src).read_text().strip()
    else:  # id z myc_p71_hits przez Management API (token w środowisku, nie wypisywany)
        q = json.dumps({"query": f"select ct from myc_p71_hits where id = {int(a.src)}"}).encode()  # noqa: S608 – int
        req = urllib.request.Request(
            "https://api.supabase.com/v1/projects/agortpieeygmcttjwjfx/database/query",
            data=q,
            headers={
                "Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
                "Content-Type": "application/json",
            },
            method="POST",
        )
        ct = json.loads(urllib.request.urlopen(req, timeout=60).read())[0]["ct"]  # noqa: S310
    d = seal.open_sealed(ct, bytes.fromhex(Path(a.key).read_text().strip()))
    k = int(d["key_hex"], 16)
    if core.address_of_key(k) != TARGET_ADDRESS:
        print("Klucz NIE daje adresu zagadki – fałszywe trafienie.", file=sys.stderr)
        return 1
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(wif(k) + "\n")
    print(f"Zgodne z {TARGET_ADDRESS}. WIF zapisany do {a.out} (chmod 600). Dalej: docs/puzzle71.md, krok 2–3.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
