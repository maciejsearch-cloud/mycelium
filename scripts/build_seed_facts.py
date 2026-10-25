"""Zweryfikowane fakty startowe („od Grok Bota”) z otwartych źródeł – każdy z linkiem, datą pobrania i licencją.

* Wikidata (CC0): krótkie polskie zdania z trójek – stolica, kontynent, państwo miasta, język urzędowy, waluta,
  autor dzieła, twórca obrazu, odkrywca/wynalazca, data urodzenia (laureaci Nagrody Nobla), symbol i liczba atomowa
  pierwiastka, ujście rzeki. Tylko pozycje z polskimi etykietami, tylko wartości bieżące (bez kwalifikatora „data końca”),
  relacje funkcyjne (stolica, data urodzenia) tylko przy jednej wartości.
* Wikisłownik (CC BY-SA 4.0): pierwsza definicja polskiego rzeczownika dla częstych słów ze słownika taksonomii.

Wykluczenia (uczciwa ocena): zdania o skrócie (sha256 po normalizacji) lub 8-gramie z zestawu bramki LM
(``web/public/data/lm/eval.bin`` – wszystkie wiersze) oraz fakty będące odpowiedzią na pytanie z
``benchmarks/chat_facts/chat_facts_v1.json`` (ten sam podmiot i pasujące wyrażenie odpowiedzi).

Wynik: ``web/public/data/seed/facts.json`` (pamięć wiedzy czatu) – ``--push`` dosyła je też jako strzępki (myc_frag_add).

    python scripts/build_seed_facts.py --gate /tmp/gate_texts.json [--push]
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from iot_mycelium.mesh.selfplay import ngrams, norm, qhash  # noqa: E402

OUT = ROOT / "web" / "public" / "data" / "seed" / "facts.json"
UA = "mycelium-seed/1 (https://github.com/maciejsearch-cloud/mycelium)"
MONTHS = [
    "stycznia",
    "lutego",
    "marca",
    "kwietnia",
    "maja",
    "czerwca",
    "lipca",
    "sierpnia",
    "września",
    "października",
    "listopada",
    "grudnia",
]


def get(url: str, tries: int = 6) -> dict:
    for k in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=180)  # noqa: S310 – stałe adresy https Wikimedia
            return json.load(r)
        except Exception as e:  # noqa: BLE001 – limit zapytań: ponawiamy
            err = e
            time.sleep(8 * (k + 1))
    raise RuntimeError(f"{url[:80]}: {err}")


def sparql(q: str) -> list[dict]:
    rows = get("https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": q, "format": "json"}))[
        "results"
    ]["bindings"]
    return [{k: v["value"] for k, v in r.items()} for r in rows]


def qid(u: str) -> str:
    return u.rsplit("/", 1)[1]


PL = 'FILTER(lang(?{0})="pl")'
LBL = '?{0} rdfs:label ?{0}L FILTER(lang(?{0}L)="pl")'


def cur(prop: str, s: str, o: str) -> str:
    """Wartość bieżąca (bez daty końca) – p:/ps: z FILTER NOT EXISTS pq:P582."""
    return f"?{s} p:{prop} ?st_{o} . ?st_{o} ps:{prop} ?{o} . FILTER NOT EXISTS {{ ?st_{o} pq:P582 [] }}"


# (nazwa, zapytanie, rel, funkcyjna, szablon zdania)
QUERIES = [
    (
        "stolica",
        "SELECT ?s ?sL ?o ?oL WHERE { ?s wdt:P31 wd:Q6256 . FILTER NOT EXISTS { ?s wdt:P576 [] } "
        + cur("P36", "s", "o")
        + " . "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "stolica",
        True,
        "{s} – stolica: {o}.",
    ),
    (
        "stolica_woj",
        "SELECT ?s ?sL ?o ?oL WHERE { ?s wdt:P31 wd:Q150093 . FILTER NOT EXISTS { ?s wdt:P576 [] } "
        + cur("P36", "s", "o")
        + " . "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "stolica",
        True,
        "{s} – stolica: {o}.",
    ),
    (
        "kontynent",
        "SELECT ?s ?sL ?o ?oL WHERE { ?s wdt:P31 wd:Q6256 ; wdt:P30 ?o . "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "kontynent",
        True,
        "{s} – kontynent: {o}.",
    ),
    (
        "jezyk",
        "SELECT ?s ?sL ?o ?oL WHERE { ?s wdt:P31 wd:Q6256 ; wdt:P37 ?o . "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "jezyk_urzedowy",
        False,
        "{s} – język urzędowy: {o}.",
    ),
    (
        "waluta",
        "SELECT ?s ?sL ?o ?oL WHERE { ?s wdt:P31 wd:Q6256 . "
        + cur("P38", "s", "o")
        + " . "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "waluta",
        False,
        "{s} – waluta: {o}.",
    ),
    (
        "miasto",
        "SELECT ?s ?sL ?o ?oL WHERE { ?s wdt:P31 wd:Q1549591 ; wikibase:sitelinks ?n . FILTER(?n >= 25) "
        + cur("P17", "s", "o")
        + " . "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "panstwo",
        True,
        "{s} – państwo: {o}.",
    ),
    (
        "autor",
        "SELECT ?s ?sL ?o ?oL WHERE { ?s wdt:P31 wd:Q7725634 ; wikibase:sitelinks ?n ; wdt:P50 ?o . FILTER(?n >= 25) "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "autor",
        False,
        "„{s}” – autor: {o}.",
    ),
    (
        "obraz",
        "SELECT ?s ?sL ?o ?oL WHERE { ?s wdt:P31 wd:Q3305213 ; wikibase:sitelinks ?n ; wdt:P170 ?o . FILTER(?n >= 20) "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "tworca",
        False,
        "„{s}” (obraz) – twórca: {o}.",
    ),
    (
        "odkrywca",
        "SELECT ?s ?sL ?o ?oL WHERE { ?s wdt:P61 ?o ; wikibase:sitelinks ?n . FILTER(?n >= 30) "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "odkrywca",
        False,
        "{s} – odkrywca lub wynalazca: {o}.",
    ),
    (
        "rzeka",
        "SELECT ?s ?sL ?o ?oL WHERE { ?s wdt:P31 wd:Q4022 ; wikibase:sitelinks ?n ; wdt:P403 ?o . FILTER(?n >= 30) "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "ujscie",
        True,
        "{s} (rzeka) – uchodzi do: {o}.",
    ),
    (
        "symbol",
        "SELECT ?s ?sL ?o WHERE { ?s wdt:P31 wd:Q11344 ; wdt:P246 ?o . " + LBL.format("s") + " }",
        "symbol",
        True,
        "{s} – symbol chemiczny: {o}.",
    ),
    (
        "liczba_atomowa",
        "SELECT ?s ?sL ?o WHERE { ?s wdt:P31 wd:Q11344 ; wdt:P1086 ?o . " + LBL.format("s") + " }",
        "liczba_atomowa",
        True,
        "{s} – liczba atomowa: {o}.",
    ),
    (
        "nobel_ur",
        "SELECT DISTINCT ?s ?sL ?o ?prec WHERE { ?s wdt:P166 ?aw . ?aw wdt:P279* wd:Q7191 . ?s p:P569/psv:P569 ?v . ?v wikibase:timeValue ?o ; wikibase:timePrecision ?prec . "
        + LBL.format("s")
        + " }",
        "data_urodzenia",
        True,
        "{s} – data urodzenia: {o}.",
    ),
    (
        "nobel",
        "SELECT DISTINCT ?s ?sL ?o ?oL WHERE { ?s wdt:P166 ?o . ?o wdt:P279* wd:Q7191 . "
        + LBL.format("s")
        + " . "
        + LBL.format("o")
        + " }",
        "laureat",
        False,
        "{s} – laureat: {o}.",
    ),
]


def date_pl(iso: str) -> str:
    m = re.match(r"^\+?(-?\d{1,4})-(\d\d)-(\d\d)", iso)
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return f"{d} {MONTHS[mo - 1]} {y} r."


def wikidata_facts(today: str) -> list[dict]:
    out = []
    for name, q, rel, functional, tpl in QUERIES:
        rows = sparql(q)
        time.sleep(2)
        by: dict[str, list[dict]] = {}
        for r in rows:
            if name == "nobel_ur":
                if r.get("prec") != "11":  # tylko pełna data (dzień)
                    continue
                r["oL"] = date_pl(r["o"])
            by.setdefault(r["s"], []).append(r)
        n0 = len(out)
        for s, rs in by.items():
            vals = {r.get("oL") or r["o"] for r in rs}
            if functional and len(vals) != 1:
                continue  # niejednoznaczne (kilka stolic, kilka dat) – pomijamy
            for v in sorted(vals):
                subj = rs[0]["sL"]
                if not subj or re.fullmatch(r"Q\d+", subj) or len(subj) > 120 or len(v) > 200:
                    continue
                # planetoidy i obiekty z oznaczeniem katalogowym („(1628) Strobel”) – masowo tworzone, mało wartościowe
                if rel == "odkrywca" and (re.match(r"^\(\d", subj) or re.search(r"\d{3,}|/", subj)):
                    continue
                o_q = next(
                    (
                        qid(r["o"])
                        for r in rs
                        if (r.get("oL") or r["o"]) == v and r["o"].startswith("http://www.wikidata.org/entity/")
                    ),
                    None,
                )
                out.append(
                    {
                        "subj": subj,
                        "rel": rel,
                        "obj": v,
                        "text": tpl.format(s=subj, o=v).replace("..", "."),
                        "source": "wikidata",
                        "url": f"https://www.wikidata.org/wiki/{qid(s)}",
                        "obj_qid": o_q,
                        "licence": "CC0 1.0",
                        "retrieved": today,
                    }
                )
        print(f"wikidata {name}: {len(out) - n0}", flush=True)
    return out


def clean_wiki(s: str) -> str:
    s = re.sub(r"<ref[^>]*/>|<ref.*?</ref>", "", s)
    s = re.sub(r"\{\{(?:wikipedia|wikt|zob)[^}]*\}\}", "", s)
    s = re.sub(r"\{\{([^}|]*)\|([^}|]*)\}\}", r"\2", s)  # {{lp|x}} itp.
    s = re.sub(r"\{\{([^}|]*)\}\}", "", s)  # kwalifikatory ({{daw}}, {{pot}}, {{kulin}}) – pomijamy
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"'{2,}", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", s).strip(" ;:")


def wiktionary_facts(words: list[str], today: str) -> list[dict]:
    out = []
    for i in range(0, len(words), 50):
        chunk = words[i : i + 50]
        d = get(
            "https://pl.wiktionary.org/w/api.php?"
            + urllib.parse.urlencode(
                {
                    "action": "query",
                    "prop": "revisions",
                    "rvprop": "content",
                    "rvslots": "main",
                    "format": "json",
                    "formatversion": "2",
                    "titles": "|".join(chunk),
                }
            )
        )
        for pg in d["query"].get("pages", []):
            if pg.get("missing") or not pg.get("revisions"):
                continue
            txt = pg["revisions"][0]["slots"]["main"]["content"]
            sec = re.search(
                r"==\s*" + re.escape(pg["title"]) + r"\s*\(\{\{język polski\}\}\)\s*==(.*?)(?:\n==[^=]|\Z)", txt, re.S
            )
            if not sec:
                continue
            zn = re.search(r"\{\{znaczenia\}\}(.*?)\{\{odmiana\}\}", sec.group(1), re.S)
            if not zn:
                continue
            body = zn.group(1)
            m = re.search(r"''rzeczownik[^\n]*\n((?::\s*\(\d\.\d\)[^\n]*\n?)+)", body)
            if not m:
                continue
            first = re.search(r":\s*\(\d\.\d\)\s*([^\n]+)", m.group(1))
            if not first:
                continue
            df = clean_wiki(first.group(1))
            if (
                len(df) < 8 or len(df) > 240 or "{{" in df or re.match(r"^(zob\.|od |por\.)", df)
            ):  # „zdrobn. od …” to nie definicja
                continue
            w = pg["title"]
            out.append(
                {
                    "subj": w,
                    "rel": "znaczenie",
                    "obj": df,
                    "text": f"{w} – {df}",
                    "source": "wiktionary",
                    "url": "https://pl.wiktionary.org/wiki/" + urllib.parse.quote(w.replace(" ", "_")),
                    "licence": "CC BY-SA 4.0 (autorzy Wikisłownika)",
                    "retrieved": today,
                }
            )
        time.sleep(1)
    print(f"wikisłownik: {len(out)}", flush=True)
    return out


def exclude(facts: list[dict], gate_texts: list[str], bench: dict) -> tuple[list[dict], dict]:
    gate_hash = {qhash(t) for t in gate_texts}
    gate_ng = set().union(*(ngrams(t, 8) for t in gate_texts))
    qs = []
    for it in bench["items"]:
        stems = {w[:5] for w in norm(it["q"]).split() if len(w) >= 4}
        qs.append((stems, [re.compile(a, re.I) for a in it.get("accept", [])]))
    keep, why = [], {"gate_hash": 0, "gate_8gram": 0, "chat_facts_v1": 0, "duplicate": 0}
    seen = set()
    for f in facts:
        h = qhash(f["text"])
        if h in seen:
            why["duplicate"] += 1
            continue
        seen.add(h)
        if h in gate_hash or qhash(f["obj"]) in gate_hash:
            why["gate_hash"] += 1
            continue
        if ngrams(f["text"], 8) & gate_ng:
            why["gate_8gram"] += 1
            continue
        subj = {w[:5] for w in norm(f["subj"]).split() if len(w) >= 4}
        if any(subj & st and any(a.search(f["text"]) for a in acc) for st, acc in qs):
            why["chat_facts_v1"] += 1
            continue
        f["sha"] = h[:16]
        keep.append(f)
    return keep, why


def push(facts: list[dict]) -> dict:
    """Strzępki warstwy 0 przez RPC myc_frag_add (zaufanie liczy baza ze źródła; idempotentnie po kluczu)."""
    import uuid

    sys.path.insert(0, str(ROOT / "scripts"))
    from frag_worker import req  # ten sam klient REST co węzeł strzępków

    node = str(uuid.uuid5(uuid.NAMESPACE_URL, "mycelium-seed-facts-v1"))
    tot = {"frags": 0, "conflicts": 0, "calls": 0}
    for i in range(0, len(facts), 200):
        fb = [
            {
                "layer": 0,
                "subj": f["subj"][:160],
                "rel": f["rel"],
                "obj": f["obj"][:300],
                "lang": "pl",
                "source": f["source"],
                "ref": f["url"][:200],
            }
            for f in facts[i : i + 200]
        ]
        r = req("POST", "/rpc/myc_frag_add", {"p_node": node, "p_frags": fb, "p_links": []})
        tot["frags"] += r.get("frags", 0)
        tot["conflicts"] += r.get("conflicts", 0)
        tot["calls"] += 1
        time.sleep(2)  # limiter: 40 wywołań / min
    return tot


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gate", required=True, help="teksty bramki LM (JSON, odkodowane z eval.bin)")
    ap.add_argument("--words", type=int, default=1500)
    ap.add_argument("--push", action="store_true")
    ap.add_argument("--only-push", action="store_true")
    a = ap.parse_args()
    if a.only_push:
        print(push(json.loads(OUT.read_text())["facts"]))
        return
    today = dt.date.today().isoformat()
    gate = json.loads(Path(a.gate).read_text())
    from wordfreq import zipf_frequency

    inp = json.loads((ROOT / "web" / "public" / "data" / "taxo" / "inputs.json").read_text())
    pl = sorted(
        {w for w, lang in inp["words"] if lang == "pl" and " " not in w}, key=lambda w: -zipf_frequency(w, "pl")
    )
    facts = wikidata_facts(today) + wiktionary_facts(pl[: a.words], today)
    bench = json.loads((ROOT / "benchmarks" / "chat_facts" / "chat_facts_v1.json").read_text())
    keep, why = exclude(facts, gate, bench)
    gate_sha = hashlib.sha256((ROOT / "web" / "public" / "data" / "lm" / "eval.bin").read_bytes()).hexdigest()
    by = {}
    for f in keep:
        by[f["rel"]] = by.get(f["rel"], 0) + 1
    doc = {
        "version": 1,
        "built": dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat(),
        "script": "scripts/build_seed_facts.py",
        "trust": {"wikidata": 0.9, "wiktionary": 0.8},
        "excluded": why,
        "gate": {
            "file": "web/public/data/lm/eval.bin",
            "sha256": gate_sha,
            "rows": len(gate),
            "rule": "sha256(norm(tekst)) albo wspólny 8-gram",
        },
        "licences": {
            "wikidata": "CC0 1.0 – https://creativecommons.org/publicdomain/zero/1.0/",
            "wiktionary": "CC BY-SA 4.0 – https://creativecommons.org/licenses/by-sa/4.0/ (autorzy Wikisłownika)",
        },
        "by_rel": by,
        "facts": keep,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({"n": len(keep), "excluded": why, "by_rel": by}, ensure_ascii=False))
    if a.push:
        print(push(keep))


if __name__ == "__main__":
    main()
