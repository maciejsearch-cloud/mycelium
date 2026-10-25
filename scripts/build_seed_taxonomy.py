"""Kuratorowane drzewo kategorii (seed) z otwartych źródeł – nazwy wyłącznie polskie, każda z pochodzeniem.

Źródła:
* Open English WordNet 2025 (CC-BY-4.0): łańcuch hiperonimów każdego znaczenia słowa,
* plWordNet przez OMW (licencja plWordNet): polskie lematy synsetów,
* CILI (CC-BY-4.0): mapowanie OEWN ↔ PWN 3.0/3.1,
* Wikidata (CC0): pozycja dla synsetu (P8814 = WordNet 3.1), polska etykieta, P279* (podklasa) między
  kategoriami (czy Wikidata potwierdza rodzica) i P910 (główna kategoria tematu) → kategoria polskiej Wikipedii.

Kategoria = synset z łańcuchów hiperonimów obejmujący ≥ ``MIN_WORDS`` słów, z polską nazwą (Wikidata, inaczej plWordNet),
bez zbyt ogólnych pojęć (głębokość < 4 w WordNecie) i bez „przelotowych” (≥ 90% słów rodzica); najwyżej 5 poziomów.
Słowo trafia do najgłębszej kategorii WSPÓLNEJ dla wszystkich jego głównych znaczeń (≤ 2) – gdy znaczenia się nie zgadzają,
słowo zostaje bez kategorii (nie zgadujemy). To zaufanie średnie („seed”), nie złota etykieta – w Weryfikuj można głosować.

Wynik: ``web/public/data/taxo/seed.json`` (+ wpis w meta.json, suma SHA-256).

    python scripts/build_seed_taxonomy.py
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from export_lexicon import LEX, MAX_SENSES  # noqa: E402
from export_taxonomy import load_oewn  # noqa: E402

OUT = ROOT / "web" / "public" / "data" / "taxo"
MIN_WORDS = 25
MIN_DEPTH = 4
MAX_LEVELS = 5
PASS = 0.9
MIN_KEEP = 15
# Ręczne korekty nazw (jawne, label_src="korekta"): plWordNet bywa potoczny/ekspresywny („gadzina”, „krzaczysko”),
# a P8814 w Wikidata bywa błędne („primate” → prymas). Klucz: angielski lemat synsetu OEWN. None = kategoria pominięta.
FIX = {
    "primate": "naczelne",
    "reptile": "gady",
    "bush": "krzewy",
    "cutlery": "sztućce",
    "military personnel": "wojsko",
    "assistant": "asystent",
    "garden truck": "warzywa i owoce",
    "bad person": None,
    "simple": None,
    "hoofed mammal": "kopytne",
    "chordate": "strunowce",
    "amphibian": "płazy",
    "mollusc": "mięczaki",
    "cnidarian": "parzydełkowce",
    "arachnid": "pajęczaki",
    "parrot": "papugi",
    "annelid": "pierścienice",
    "crustacean": "skorupiaki",
    "carnivore": "drapieżne",
    "subshrub": "półkrzewy",
    "soldier": "żołnierz",
    "orchid": "storczykowate",
    "female": "kobiety",
    "male": "mężczyźni",
    "adult female": "kobieta",
    "adult male": "mężczyzna",
    "seafood": "owoce morza",
    "dainty": "przysmaki",
    "covering": "okrycia i nakrycia",
}
UA = "mycelium-seed/1 (https://github.com/maciejsearch-cloud/mycelium)"


def sparql(q: str) -> list[dict]:
    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": q, "format": "json"})
    for k in range(5):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=120)  # noqa: S310 – stały adres https
            return json.load(r)["results"]["bindings"]
        except Exception:  # noqa: BLE001 – ponawiamy (limit zapytań WDQS)
            time.sleep(5 * (k + 1))
    raise RuntimeError("WDQS nie odpowiada")


def main() -> None:
    inp = json.loads((OUT / "inputs.json").read_text())
    W = inp["words"]
    words, hyper, ili, name = load_oewn()
    pwn2ili = dict(line.rstrip("\n").split("\t")[::-1] for line in (LEX / "ili-map-pwn30.tab").open())
    ili2pwn31 = dict(line.rstrip("\n").split("\t") for line in (LEX / "ili-map-pwn31.tab").open())
    ili2sid = {v: k for k, v in ili.items() if v}
    pwn2sid = {p: ili2sid[i] for p, i in pwn2ili.items() if i in ili2sid}
    sid2pwn = {s: p for p, s in pwn2sid.items()}
    pl_by_pwn: dict[str, list[str]] = defaultdict(list)
    pl_senses: dict[str, list[str]] = defaultdict(list)
    for line in (LEX / "wn-data-pol.tab").open():
        if line.startswith("#"):
            continue
        p, kind, lem = line.rstrip("\n").split("\t")[:3]
        if kind == "pol:lemma" and p.endswith("-n"):
            pl_by_pwn[p].append(lem)
            if p in pwn2sid:
                pl_senses[lem.lower()].append(pwn2sid[p])
    en_senses: dict[str, list[str]] = defaultdict(list)
    for lemma, sids in words.items():
        en_senses[lemma.lower()].extend(sids)

    def chain(s: str) -> list[str]:
        out, seen = [s], {s}
        while hyper.get(out[-1]):
            h = hyper[out[-1]][0]  # pierwszy hiperonim (główna linia dziedziczenia)
            if h in seen:
                break
            out.append(h)
            seen.add(h)
        return out[::-1]  # od korzenia do synsetu

    chains = [
        [chain(s) for s in (en_senses if lang == "en" else pl_senses).get(w.lower(), [])[:MAX_SENSES]] for w, lang in W
    ]
    depth: dict[str, int] = {}
    cnt: Counter = Counter()
    parent: dict[str, str | None] = {}
    for cs in chains:
        for c in cs:
            for k, s in enumerate(c):
                depth[s] = min(depth.get(s, 99), k)
                parent.setdefault(s, c[k - 1] if k else None)
        if cs:
            for s in set(cs[0]):
                cnt[s] += 1
    plwn = {s: (pl_by_pwn.get(sid2pwn.get(s, ""), [""])[0]) for s in cnt}

    # Wikidata: pozycje dla synsetów-kandydatów (P8814 = WordNet 3.1), polska etykieta i główna kategoria Wikipedii
    cand = [s for s, n in cnt.items() if n >= MIN_WORDS and depth[s] >= MIN_DEPTH]
    wn31 = {s: ili2pwn31.get(ili.get(s, ""), "") for s in cand}
    by31 = {v: s for s, v in wn31.items() if v}
    wd: dict[str, dict] = {}
    ids = sorted(by31)
    for i in range(0, len(ids), 150):
        vals = " ".join(f'"{x}"' for x in ids[i : i + 150])
        q = (
            "SELECT ?item ?wn ?pl ?en ?cat WHERE { VALUES ?wn {" + vals + "} ?item wdt:P8814 ?wn . "
            'OPTIONAL { ?item rdfs:label ?pl FILTER(lang(?pl)="pl") } OPTIONAL { ?item rdfs:label ?en FILTER(lang(?en)="en") } '
            "OPTIONAL { ?item wdt:P910 ?c . ?a schema:about ?c ; schema:isPartOf <https://pl.wikipedia.org/> ; schema:name ?cat } }"
        )
        for b in sparql(q):
            s = by31[b["wn"]["value"]]
            e = wd.setdefault(s, {"qid": b["item"]["value"].rsplit("/", 1)[1]})
            if "pl" in b:
                e["pl"] = b["pl"]["value"]
            if "en" in b:
                e["en"] = b["en"]["value"]
            if "cat" in b:
                e["plwiki_cat"] = b["cat"]["value"]

    lemmas: dict[str, set[str]] = defaultdict(set)
    for lemma, sids in words.items():
        for x in sids:
            lemmas[x].add(lemma.lower())
    pl_all = {x: [m.lower() for m in pl_by_pwn.get(sid2pwn.get(x, ""), [])] for x in cand}

    def agree(x: str) -> bool:
        """Wikidata i WordNet mówią o tym samym? (P8814 bywa błędne, np. „primate” → prymas)."""
        e = wd.get(x, {})
        if not e.get("pl"):
            return False
        en = e.get("en", "").lower()
        en_ok = en in lemmas[x] or en.rstrip("s") in lemmas[x]
        if pl_all.get(x):
            return en_ok and any(e["pl"].lower()[:4] == m[:4] for m in pl_all[x])
        return en_ok

    for x in list(wd):
        if not agree(x):
            wd[x]["rejected"] = True

    def label(s: str) -> tuple[str, str]:
        en = name.get(s, "")
        if en in FIX:
            return (FIX[en] or "", "korekta")
        if wd.get(s, {}).get("pl") and not wd[s].get("rejected"):
            return wd[s]["pl"], "wikidata+wordnet"
        return plwn.get(s, ""), "plwordnet"

    keep = [s for s in cand if label(s)[0]]
    keep_set = set(keep)
    wd = {x: e for x, e in wd.items() if not e.get("rejected")}

    alias: dict[str, str] = {}

    def kept_parent(s: str) -> str | None:
        p = parent.get(s)
        while p is not None and p not in keep_set and p not in alias:
            p = parent.get(p)
        return alias.get(p, p) if p is not None else None

    # bez „przelotowych” kategorii (prawie ten sam zbiór słów co rodzic) – od góry
    changed = True
    while changed:
        changed = False
        for s in sorted(keep_set, key=lambda x: depth[x]):
            p = kept_parent(s)
            if p is not None and cnt[s] >= PASS * cnt[p]:
                keep_set.discard(s)  # zostaje ogólniejszy rodzic
                changed = True
                break

    # najwyżej MAX_LEVELS poziomów: głębsze kategorie odpadają (słowa idą do przodka)
    def lvl(s: str) -> int:
        k, p = 0, kept_parent(s)
        while p is not None:
            k, p = k + 1, kept_parent(p)
        return k

    keep_set = {s for s in keep_set if lvl(s) < MAX_LEVELS}
    # ta sama polska nazwa co przodek → kategoria zbędna (np. pożywienie › pożywienie); ta sama co inna gałąź → scalenie
    first: dict[str, str] = {}
    for x in sorted(keep_set, key=lambda y: (lvl(y), -cnt[y], y)):
        key = label(x)[0].casefold()
        if key in first:
            alias[x] = first[key]
        else:
            first[key] = x
    keep_set -= set(alias)

    def canon(x: str | None) -> str | None:
        return alias.get(x, x) if x is not None else None

    # słowo → najgłębsza kategoria wspólna dla wszystkich głównych znaczeń
    def deepest(c: list[str]) -> list[str]:
        out = []
        for x in c:
            y = canon(x) if x in alias else x
            if y in keep_set and y not in out:
                out.append(y)
        return out

    mapping: list[int] = []
    order = sorted(keep_set, key=lambda s: (lvl(s), -cnt[s], s))
    cid = {s: i for i, s in enumerate(order)}
    stats = Counter()
    for cs in chains:
        if not cs:
            mapping.append(-1)
            stats["no_sense"] += 1
            continue
        sets = [deepest(c) for c in cs]
        common = [s for s in sets[0] if all(s in o for o in sets[1:])]
        if not common:
            mapping.append(-1)
            stats["senses_disagree" if any(sets) else "no_category"] += 1
            continue
        mapping.append(cid[common[-1]])
        stats["mapped"] += 1
    n_words = Counter()
    for m in mapping:
        c = order[m] if m >= 0 else None
        while c is not None:
            n_words[c] += 1
            c = kept_parent(c)

    # Wikidata P279*/P171* (podklasa / takson nadrzędny): czy rodzic kategorii jest jej nadklasą także w Wikidata
    pairs = [(wd[s]["qid"], wd[p]["qid"]) for s in order if (p := kept_parent(s)) and s in wd and p in wd]
    ok: set[tuple[str, str]] = set()
    for i in range(0, len(pairs), 80):
        vals = " ".join(f"(wd:{a} wd:{b})" for a, b in pairs[i : i + 80])
        for b in sparql("SELECT ?c ?p WHERE { VALUES (?c ?p) {" + vals + "} ?c (wdt:P279|wdt:P171)* ?p }"):
            ok.add((b["c"]["value"].rsplit("/", 1)[1], b["p"]["value"].rsplit("/", 1)[1]))

    cats = []
    for s in order:
        p = kept_parent(s)
        pl, src = label(s)
        e = {
            "id": len(cats),
            "parent": cid[p] if p is not None else -1,
            "lvl": lvl(s),
            "pl": pl,
            "en": name.get(s, s),
            "label_src": src,
            "synset": s,
            "n": n_words[s],
        }
        if s in wd:
            e["qid"] = wd[s]["qid"]
            if "plwiki_cat" in wd[s]:
                e["plwiki_cat"] = wd[s]["plwiki_cat"]
            if p is not None and p in wd:
                e["wd_parent_ok"] = (wd[s]["qid"], wd[p]["qid"]) in ok
        cats.append(e)
    # kategorie z mniej niż MIN_KEEP słowami odpadają (słowa idą do najbliższego zachowanego przodka)
    alive = {c["id"] for c in cats if c["n"] >= MIN_KEEP}
    remap, out_cats = {}, []

    def up(i: int) -> int:
        while i >= 0 and i not in remap:
            i = cats[i]["parent"]
        return remap.get(i, -1)

    for c in cats:  # rodzice przed dziećmi (porządek po poziomie)
        if c["id"] in alive:
            remap[c["id"]] = len(out_cats)
            par = up(c["parent"])
            out_cats.append({**c, "id": len(out_cats), "parent": par})
    mapping = [up(m) if m >= 0 else -1 for m in mapping]
    lv: list[int] = []
    for c in out_cats:  # poziomy po usunięciu
        lv.append(lv[c["parent"]] + 1 if c["parent"] >= 0 else 0)
        c["lvl"] = lv[-1]
        c.pop("wd_parent_ok", None) if c["parent"] < 0 else None
    built = dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat()
    seed = {
        "version": 1,
        "built": built,
        "script": "scripts/build_seed_taxonomy.py",
        "inputs_sha": hashlib.sha256((OUT / "inputs.json").read_bytes()).hexdigest(),
        "rule": f"kategoria: ≥{MIN_WORDS} słów, głębokość WordNet ≥{MIN_DEPTH}, polska nazwa, bez przelotowych (≥{PASS:.0%} rodzica), ≤{MAX_LEVELS} poziomów; słowo: najgłębsza kategoria wspólna dla ≤{MAX_SENSES} głównych znaczeń",
        "trust": 0.6,
        "sources": [
            {"name": "Open English WordNet 2025", "licence": "CC BY 4.0", "url": "https://en-word.net/"},
            {
                "name": "plWordNet (przez Open Multilingual Wordnet)",
                "licence": "plWordNet licence",
                "url": "https://plwordnet.pwr.wroc.pl/",
            },
            {"name": "CILI", "licence": "CC BY 4.0", "url": "https://github.com/globalwordnet/cili"},
            {
                "name": "Wikidata (P8814, P279, P910, etykiety PL)",
                "licence": "CC0 1.0",
                "url": "https://www.wikidata.org/",
            },
            {
                "name": "Polska Wikipedia – kategorie (przez P910)",
                "licence": "CC BY-SA 4.0",
                "url": "https://pl.wikipedia.org/",
            },
        ],
        "cats": out_cats,
        "map": mapping,
        "stats": {**stats, "mapped": sum(1 for m in mapping if m >= 0), "cats": len(out_cats)},
    }
    (OUT / "seed.json").write_text(json.dumps(seed, ensure_ascii=False, separators=(",", ":")))
    meta = json.loads((OUT / "meta.json").read_text())
    meta["files"]["seed.json"] = hashlib.sha256((OUT / "seed.json").read_bytes()).hexdigest()
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(seed["stats"], ensure_ascii=False))


if __name__ == "__main__":
    main()
