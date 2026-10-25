"""Słownik rejestru (wulgaryzmy, potoczne reakcje) z polskiego Wikisłownika – dla czatu grzybni.

Źródło: pl.wiktionary.org (CC BY-SA 4.0, autorzy Wikisłownika). Bierzemy hasła z sekcji „język polski”, w których
znaczenie ma kwalifikator {{wulg}} (wulgarne) albo {{pot}}/{{posp}} razem z {{obraź}}/{{pogard}}/{{lekcew}}/{{iron}},
oraz krótką listę słów reakcji (np. „bzdura”, „ściemniać”). Do każdego czasownika dopisujemy formy
2. i 3. osoby (pierdolić → pierdolisz, pierdoli), żeby czat rozpoznał „pierdolisz”.
Wynik: web/public/data/register.json  (python scripts/export_register.py)
"""

from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://pl.wiktionary.org/w/api.php"
OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "data" / "register.json"
UA = {"User-Agent": "mycelium-ai-register/1.0 (https://maciejsearch-cloud.github.io/demo/mycelium/)"}
# słowa reakcji spoza {{wulg}} (niezgoda, frustracja, obelga) – ich definicje też z Wikisłownika
EXTRA = [
    "bzdura",
    "bzdurny",
    "brednia",
    "bredzić",
    "ściemniać",
    "kłamać",
    "kłamstwo",
    "głupota",
    "głupi",
    "debil",
    "idiota",
    "kretyn",
    "matoł",
    "spadać",
    "zamknąć się",
    "nieprawda",
    "kurde",
    "kurczę",
    "cholera",
    "masakra",
    "żenada",
    "gadać",
    "pleść",
    "pieprzyć",
    "chrzanić",
    "gówno",
    "dupa",
    "kicha",
    "lipa",
    "porażka",
    "beznadzieja",
    "ściema",
]


def api(**q) -> dict:
    q |= {"format": "json", "formatversion": "2"}
    for i in range(5):
        try:
            r = urllib.request.Request(API + "?" + urllib.parse.urlencode(q), headers=UA)  # noqa: S310
            with urllib.request.urlopen(r, timeout=60) as f:  # noqa: S310 (stały publiczny adres)
                return json.loads(f.read())
        except OSError:
            time.sleep(2**i)
    raise RuntimeError("Wikisłownik nie odpowiada")


def embedded(tpl: str) -> list[str]:
    out, cont = [], {}
    while True:
        d = api(action="query", list="embeddedin", eititle=f"Szablon:{tpl}", eilimit="500", einamespace="0", **cont)
        out += [x["title"] for x in d["query"]["embeddedin"]]
        if "continue" not in d:
            return out
        cont = {"eicontinue": d["continue"]["eicontinue"]}


def texts(titles: list[str]) -> dict[str, str]:
    out = {}
    for i in range(0, len(titles), 50):
        d = api(action="query", prop="revisions", rvprop="content", rvslots="main", titles="|".join(titles[i : i + 50]))
        for p in d["query"]["pages"]:
            if "revisions" in p:
                out[p["title"]] = p["revisions"][0]["slots"]["main"]["content"]
        time.sleep(0.3)
    return out


def clean(s: str) -> str:
    s = re.sub(
        r"\{\{(?:wulg|pot|posp|obraź|pogard|lekcew|iron|żart|przen|środ|slang|ekspr|zgrub|euf|rzad|daw|reg[^}]*)\}\}",
        "",
        s,
    )
    s = re.sub(r"\{\{[^{}|]*\|([^{}|]*)\}\}", r"\1", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"<ref.*?(</ref>|/>)", "", s, flags=re.S)
    s = re.sub(r"<[^>]+>|'''?", "", s)
    return re.sub(r"\s+", " ", s).strip(" ;,.:")


def parse(title: str, wt: str) -> dict | None:
    m = re.search(r"==\s*[^=\n]*\(\{\{język polski\}\}\)\s*==(.*?)(?=\n==[^=]|\Z)", wt, re.S)
    if not m:
        return None
    sec = m.group(1)
    z = re.search(r"\{\{znaczenia\}\}(.*?)(?=\n\{\{[a-ząćęłńóśźż ]+\}\}\s*\n)", sec, re.S)
    if not z:
        return None
    defs, regs, pos = [], set(), ""
    for line in z.group(1).splitlines():
        if line.startswith("''"):
            pos = clean(line)
            continue
        dm = re.match(r":\s*\(\d+\.\d+\)\s*(.*)", line)
        if not dm:
            continue
        raw = dm.group(1)
        r = set()
        if "{{wulg}}" in raw:
            r.add("wulgarne")
        if re.search(r"\{\{(pot|posp)\}\}", raw):
            r.add("potoczne")
        if re.search(r"\{\{(obraź|pogard|lekcew)\}\}", raw):
            r.add("obraźliwe")
        if "{{iron}}" in raw:
            r.add("ironiczne")
        g = clean(raw)
        if 3 <= len(g) <= 220:
            defs.append({"d": g, "reg": sorted(r), "pos": pos[:40]})
            regs |= r
    if not defs:
        return None
    return {"w": title, "reg": sorted(regs), "defs": defs[:4], "forms": forms(title, pos)}


def forms(w: str, pos: str) -> list[str]:
    """Najczęstsze formy osobowe czasownika (bez pełnej odmiany): -ić/-yć → -isz/-ysz/-i, -ać → -asz/-a, -eć → -isz/-i."""
    if "czasownik" not in pos or " " in w:
        return []
    for end, f in (
        ("ić", ("isz", "i", "isz się")),
        ("yć", ("ysz", "y")),
        ("ać", ("asz", "a", "acie")),
        ("eć", ("isz", "i", "esz")),
    ):
        if w.endswith(end):
            st = w[: -len(end)]
            return sorted({st + x for x in f if " " not in x} | {w[: -len(end)] + "isz" if end == "ić" else st + f[0]})
    return []


def main():
    titles = sorted(set(embedded("wulg")))
    print("hasła z {{wulg}}:", len(titles))
    wt = texts(titles + EXTRA)
    entries = []
    for t, s in wt.items():
        e = parse(t, s)
        if not e:
            continue
        if t not in EXTRA and "wulgarne" not in e["reg"]:
            continue  # {{wulg}} był w innym języku na tej stronie
        if t not in EXTRA:
            e["defs"] = [d for d in e["defs"] if d["reg"]] or e["defs"]
        entries.append(e)
    entries.sort(key=lambda e: e["w"])
    OUT.write_text(
        json.dumps(
            {
                "source": "pl.wiktionary.org – sekcje „język polski”, kwalifikatory wulg./pot./obraź./pogard./lekcew.",
                "license": "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); autorzy Wikisłownika",
                "built": time.strftime("%Y-%m-%d"),
                "n": len(entries),
                "entries": entries,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    print("zapisano", len(entries), "haseł →", OUT)


if __name__ == "__main__":
    main()
