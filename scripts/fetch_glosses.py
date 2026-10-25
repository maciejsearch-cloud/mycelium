"""Definicje słów z angielskiego Wikisłownika (REST API Wikimedia, CC BY-SA) jako cechy tekstowe klasyfikatora słów.

Wikisłownik jest niezależny od WordNetu (z którego pochodzą etykiety), więc to nie przeciek etykiety.
Ta sama funkcja (glossFor w przeglądarce) pobiera definicję dla nowego słowa w chwili klasyfikacji.
Wynik: ~/.cache/iot-mycelium/gloss.json {"lang:word": "definicja; definicja"}.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = Path.home() / ".cache" / "iot-mycelium" / "gloss.json"
UA = "MyceliumAI/1.0 (https://maciejsearch-cloud.github.io/demo/mycelium/; research demo)"


def pick(d: dict, lang: str) -> str:
    """Do 2 definicji rzeczownika w języku słowa (pl → klucz 'pl' albo 'other'), inaczej dowolna część mowy."""
    keys = [lang] if lang == "en" else ["pl", "other"]
    for noun_only in (True, False):
        out: list[str] = []
        for k in keys:
            for e in d.get(k, []):
                if noun_only and e.get("partOfSpeech") != "Noun":
                    continue
                for df in e.get("definitions", []):
                    t = re.sub(r"<[^>]+>", "", df.get("definition", "")).strip()
                    t = re.sub(r"\s+", " ", t)
                    if t:
                        out.append(t[:160])
        if out:
            return "; ".join(out[:2])
    return ""


def fetch(word: str, lang: str) -> str:
    url = "https://en.wiktionary.org/api/rest_v1/page/definition/" + urllib.parse.quote(word)
    for i in range(4):
        try:
            r = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(r, timeout=20) as f:  # noqa: S310 (stały adres Wikimedia)
                return pick(json.loads(f.read()), lang)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return ""
            time.sleep(1 + 2 * i)
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            time.sleep(1 + 2 * i)
    return ""


def main() -> None:
    lex = json.loads((ROOT / "web" / "public" / "data" / "lexicon.json").read_text())
    cache: dict[str, str] = json.loads(OUT.read_text()) if OUT.exists() else {}
    todo = [(w, lang) for w, lang, cats in lex["words"] if cats and f"{lang}:{w}" not in cache]
    print(f"do pobrania: {len(todo)}", flush=True)
    with ThreadPoolExecutor(16) as ex:
        for k, ((w, lang), g) in enumerate(zip(todo, ex.map(lambda x: fetch(*x), todo), strict=True)):
            cache[f"{lang}:{w}"] = g
            if k % 500 == 499:
                OUT.write_text(json.dumps(cache, ensure_ascii=False))
                print(k + 1, flush=True)
    OUT.write_text(json.dumps(cache, ensure_ascii=False))
    have = sum(1 for v in cache.values() if v)
    print(f"definicje: {have}/{len(cache)}", file=sys.stderr)


if __name__ == "__main__":
    main()
