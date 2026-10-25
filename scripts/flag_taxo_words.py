"""Jakość słów w taksonomii: oznacza podejrzane nie-słowa (błędy słownika) do odsunięcia w kolejce Weryfikuj.

Słowo jest **podejrzane**, gdy jednocześnie:
* częstość w korpusach `wordfreq` (Wikipedia, napisy, sieć, …) = 0 (zipf 0),
* brak hasła w Wikisłowniku (pl.wiktionary dla PL, en.wiktionary dla EN),
* mniej niż ``MIN_HITS`` trafień dokładnej frazy w Wikipedii (pl/en, wyszukiwarka CirrusSearch).

Wynik: ``web/public/data/taxo/quality.json`` (z datą i źródłami). Uruchomienie: ``python scripts/flag_taxo_words.py``
(wymaga ``pip install wordfreq`` i dostępu do API Wikimedia; zapytania są grupowane i z przerwą).
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from wordfreq import zipf_frequency

ROOT = Path(__file__).resolve().parents[1]
D = ROOT / "web" / "public" / "data" / "taxo"
UA = "MyceliumAI-lexicon-check/1.0 (https://github.com/maciejsearch-cloud/mycelium)"
MIN_HITS = 3


def api(host: str, params: dict) -> dict:
    q = urllib.parse.urlencode({**params, "format": "json", "maxlag": 5})
    req = urllib.request.Request(f"https://{host}/w/api.php?{q}", headers={"User-Agent": UA})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 - stałe adresy https Wikimedia
                d = json.load(r)
            if "error" in d and d["error"].get("code") == "maxlag":
                time.sleep(5)
                continue
            return d
        except OSError:
            time.sleep(2 + 3 * attempt)
    raise RuntimeError(f"API {host} niedostępne")


def wiktionary(words: list[str], lang: str) -> set[str]:
    have: set[str] = set()
    host = f"{lang}.wiktionary.org"
    for i in range(0, len(words), 50):
        chunk = words[i : i + 50]
        d = api(host, {"action": "query", "titles": "|".join(chunk)})
        norm = {n["to"]: n["from"] for n in d["query"].get("normalized", [])}
        for p in d["query"]["pages"].values():
            if "missing" not in p:
                have.add(norm.get(p["title"], p["title"]))
        time.sleep(0.2)
    return have


def wiki_hits(word: str, lang: str) -> int:
    d = api(
        f"{lang}.wikipedia.org",
        {
            "action": "query",
            "list": "search",
            "srsearch": f'"{word}"',
            "srwhat": "text",
            "srlimit": 1,
            "srinfo": "totalhits",
        },
    )
    return int(d["query"]["searchinfo"]["totalhits"])


def main() -> None:
    inputs = json.loads((D / "inputs.json").read_text())
    words = [tuple(w) for w in inputs["words"]]
    zipf = [round(zipf_frequency(w, lang), 2) for w, lang in words]
    wikt = [False] * len(words)
    for lang in ("pl", "en"):
        idx = [i for i, (_, lg) in enumerate(words) if lg == lang]
        have = wiktionary([words[i][0] for i in idx], lang)
        for i in idx:
            wikt[i] = words[i][0] in have
    hits: dict[int, int] = {}
    for i, (w, lang) in enumerate(words):
        if zipf[i] == 0 and not wikt[i]:
            hits[i] = wiki_hits(w, lang)
            time.sleep(0.15)
    suspect = sorted(i for i, h in hits.items() if h < MIN_HITS)
    out = {
        "version": 1,
        "built": datetime.now(UTC).isoformat(timespec="seconds"),
        "script": "scripts/flag_taxo_words.py",
        "inputs_sha": json.loads((D / "meta.json").read_text())["files"]["inputs.json"],
        "rule": f"zipf == 0 (wordfreq) AND not in Wiktionary AND Wikipedia exact-phrase hits < {MIN_HITS}",
        "sources": [
            "wordfreq (Wikipedia, OpenSubtitles, Common Crawl, …)",
            "pl/en.wiktionary.org API",
            "pl/en.wikipedia.org search API",
        ],
        "zipf": zipf,
        "wiktionary": [1 if x else 0 for x in wikt],
        "wiki_hits": {str(i): h for i, h in hits.items()},
        "suspect": suspect,
    }
    (D / "quality.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"quality.json: {len(words)} słów, bez częstości i Wikisłownika {len(hits)}, podejrzanych {len(suspect)}")


if __name__ == "__main__":
    main()
