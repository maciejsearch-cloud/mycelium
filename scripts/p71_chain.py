"""Saldo adresu Puzzle #71 z dwóch publicznych eksploratorów (mempool.space, blockstream.info) – przy budowie strony.

Zapisuje web/public/data/p71-chain.json tylko, gdy oba źródła się zgadzają (inaczej zostawia poprzedni plik i kończy
się kodem 1). Strona i tak pobiera saldo na żywo; ten plik to zapas z datą pobrania.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

ADDR = "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU"
SOURCES = {
    "mempool.space": f"https://mempool.space/api/address/{ADDR}",
    "blockstream.info": f"https://blockstream.info/api/address/{ADDR}",
}
OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "data" / "p71-chain.json"


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "mycelium-p71/1"})  # noqa: S310 – stałe adresy https
    d = json.loads(urllib.request.urlopen(req, timeout=20).read())  # noqa: S310 – stały adres https
    c, m = d["chain_stats"], d["mempool_stats"]
    return {
        "funded_sat": c["funded_txo_sum"],
        "spent_sat": c["spent_txo_sum"],
        "balance_sat": c["funded_txo_sum"] - c["spent_txo_sum"],
        "tx_count": c["tx_count"],
        "mempool_spent_sat": m["spent_txo_sum"],
    }


def main() -> int:
    got = {}
    for name, url in SOURCES.items():
        try:
            got[name] = fetch(url)
        except Exception as e:  # noqa: BLE001
            print(f"{name}: błąd {e}", file=sys.stderr)
    vals = list(got.values())
    if len(vals) < 2 or vals[0] != vals[1]:
        print("p71: źródła niezgodne albo niedostępne – zostawiam poprzedni plik", file=sys.stderr)
        return 1
    out = {
        "address": ADDR,
        **vals[0],
        "sources": sorted(got),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
