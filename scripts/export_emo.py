"""Leksykon emocji dla rozmówcy czatu (web/src/myc/rozmowa): z „Emotional Annotations Dictionary” (Słowosieć 4.0).

Źródło: Zaśko-Zielińska, Monika, 2018, Emotional Annotations Dictionary, CLARIN-PL, http://hdl.handle.net/11321/553
Licencja: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) – uznanie autorstwa w meta pliku i w DATA-LICENSES.md.

Plik wejściowy: słownik_anotacji_emocjonlanej.csv (ZIP z CLARIN-PL, MD5 zip d8a46896c664c6daa86f1a35dc0c43a4).
Wyjście: web/public/data/rozmowa/emo.json.gz – {meta, lem: {lemat: [nacechowanie, maska_emocji]}}
  nacechowanie: średnia po anotacjach jednostek leksykalnych lematu (+ s = 2, + m = 1, amb = 0, - m = -1, - s = -2),
  zaokrąglona do liczby całkowitej; maska: bity emocji podstawowych (kolejność EMO), gdy ≥ 1/3 anotacji je podaje.
Bez nacechowania i bez emocji → lemat pominięty.

Użycie: python scripts/export_emo.py <ścieżka.csv>
"""

from __future__ import annotations

import csv
import gzip
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "data" / "rozmowa" / "emo.json.gz"
EMO = ["radość", "zaufanie", "oczekiwanie", "zaskoczenie", "smutek", "złość", "strach", "wstręt"]
ALIAS = {
    "cieszenie się na coś oczekiwanego": "oczekiwanie",
    "cieszenie się na": "oczekiwanie",
    "zaskoczenie czymś nieprzewidywanym": "zaskoczenie",
}
POL = {"+ s": 2, "+ m": 1, "amb": 0, "- m": -1, "- s": -2}


def main(path: str) -> None:
    pol: dict[str, list[int]] = defaultdict(list)
    emo: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    n_ann: dict[str, int] = defaultdict(int)
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            lem = (r["lemat"] or "").strip().lower()
            st = (r["stopien_nacechowania"] or "").strip()
            if not lem or " " in lem or st not in POL:
                continue
            pol[lem].append(POL[st])
            n_ann[lem] += 1
            for e in (r["emocje"] or "").split(";"):
                e = ALIAS.get(e.strip(), e.strip())
                if e in EMO:
                    emo[lem][e] += 1
    lem_out: dict[str, list[int]] = {}
    for lem, ps in pol.items():
        p = round(sum(ps) / len(ps))
        mask = 0
        for i, e in enumerate(EMO):
            if emo[lem].get(e, 0) * 3 >= n_ann[lem]:
                mask |= 1 << i
        if p or mask:
            lem_out[lem] = [p, mask]
    meta = {
        "source": "Emotional Annotations Dictionary (Słowosieć 4.0), M. Zaśko-Zielińska, CLARIN-PL 2018",
        "url": "http://hdl.handle.net/11321/553",
        "license": "CC BY 4.0",
        "emo": EMO,
        "n": len(lem_out),
        "note": "nacechowanie = średnia anotacji jednostek lematu (+s=2,+m=1,amb=0,-m=-1,-s=-2); maska = emocje w ≥ 1/3 anotacji",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps({"meta": meta, "lem": dict(sorted(lem_out.items()))}, ensure_ascii=False, separators=(",", ":"))
    with gzip.GzipFile(OUT, "wb", mtime=0) as g:
        g.write(raw.encode())
    print(f"{OUT.relative_to(ROOT)}: {len(lem_out)} lematów, {OUT.stat().st_size} B")


if __name__ == "__main__":
    main(sys.argv[1])
