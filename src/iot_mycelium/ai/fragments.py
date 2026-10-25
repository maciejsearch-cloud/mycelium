"""„Strzępki” – wielowarstwowa wiedza grzybni („po nitce do kłębka”).

Warstwa 0: atomowe fakty ``(podmiot, relacja, obiekt)`` ze źródłem (słownik, Wikidata,
konsensus węzłów, nauczyciel, captcha). Warstwa 1: pojęcia – jedna encja łączy wszystkie
swoje strzępki (``part_of``), pojęcia łączą się ze sobą (``is_a``, ``translation``,
``synonym``). Warstwa 2: tematy – korzenie hierarchii ``is_a`` (np. „Zwierzę”), do których
prowadzi każda nić.

Wszystko liczone deterministycznie z prawdziwych danych (słowniki w ``web/public/data``,
odpowiedzi węzłów z bazy). Klucz strzępka jest identyczny z ``myc_frag_key`` w SQL, więc
każdy węzeł może dosyłać te same strzępki – baza je łączy i zlicza potwierdzenia.
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

FUNCTIONAL = {
    "populacja",
    "stolica",
    "powierzchnia",
    "rok",
    "data_urodzenia",
    "data_smierci",
    "wysokosc",
    "intencja",
    "etykieta",
    "tlumaczenie_odp",
}
MIN_CONF = 0.8  # konsensus poniżej tej pewności nie staje się strzępkiem (trafia do Weryfikuj)
CONCEPT_MAX_WORDS = 4  # dłuższe podmioty to zdania/twierdzenia, nie encje


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


@dataclass(frozen=True)
class Frag:
    layer: int
    subj: str
    rel: str
    obj: str = ""
    lang: str = "pl"
    source: str = "link"
    ref: str | None = None
    hint: float | None = None

    @property
    def key(self) -> str:
        return f"{self.layer}:{norm(self.subj)}|{self.rel}|{norm(self.obj)}"

    def ref_json(self) -> dict[str, Any]:
        return {"layer": self.layer, "subj": self.subj, "rel": self.rel, "obj": self.obj}

    def json(self) -> dict[str, Any]:
        d = self.ref_json() | {"lang": self.lang, "source": self.source}
        if self.ref:
            d["ref"] = self.ref
        if self.hint is not None:
            d["hint"] = round(float(self.hint), 4)
        return d


@dataclass(frozen=True)
class Link:
    src: Frag
    dst: Frag
    kind: str
    w: float = 1.0

    def json(self) -> dict[str, Any]:
        return {"src": self.src.ref_json(), "dst": self.dst.ref_json(), "kind": self.kind, "w": round(self.w, 4)}


@dataclass
class Graph:
    frags: dict[str, Frag] = field(default_factory=dict)
    links: dict[tuple[str, str, str], Link] = field(default_factory=dict)

    def add(self, f: Frag) -> Frag:
        return self.frags.setdefault(f.key, f)

    def link(self, a: Frag, b: Frag, kind: str, w: float = 1.0) -> None:
        if a.key != b.key:
            self.links.setdefault((a.key, b.key, kind), Link(a, b, kind, w))

    def layer_counts(self) -> dict[int, int]:
        c: dict[int, int] = defaultdict(int)
        for f in self.frags.values():
            c[f.layer] += 1
        return dict(sorted(c.items()))


# ---------- warstwa 0: ekstrakcja ----------


def _cat_names(lex: Mapping[str, Any]) -> list[str]:
    return [c["pl"] for c in lex["taxonomy"]]


def from_lexicon(lex: Mapping[str, Any], start: int = 0, limit: int | None = None) -> list[Frag]:
    """Słowo → kategoria (WordNet/plWordNet) oraz hierarchia kategorii (is-a)."""
    tax = lex["taxonomy"]
    names = _cat_names(lex)
    out: list[Frag] = []
    if start == 0:
        for c in tax:
            if c["parent"]:
                parent = next(p for p in tax if p["id"] == c["parent"])
                out.append(Frag(0, c["pl"], "jest", parent["pl"], "pl", "wordnet", "CILI"))
    words = lex["words"][start : None if limit is None else start + limit]
    for word, lang, cats in words:
        src = "plwordnet" if lang == "pl" else "wordnet"
        for ci in cats:
            out.append(Frag(0, word, "jest", names[ci], lang, src, "lexicon"))
    return out


def from_pairs(pairs: Iterable[Mapping[str, str]]) -> list[Frag]:
    """Pary PL↔EN z plWordNet/OMW."""
    return [Frag(0, p["pl"], "tlumaczenie", p["en"], "pl", "plwordnet", p.get("id")) for p in pairs]


def from_consensus(
    truths: Mapping[str, tuple[str, float]],
    qa: Mapping[str, Any] | None = None,
    lex: Mapping[str, Any] | None = None,
    pairs: Mapping[str, Mapping[str, str]] | None = None,
    fashion_pl: list[str] | None = None,
    user_qs: Iterable[Mapping[str, Any]] = (),
    min_conf: float = MIN_CONF,
) -> list[Frag]:
    """Zweryfikowane (pewne) odpowiedzi grzybni → strzępki. Niepewne pomija (idą do Weryfikuj)."""
    out: list[Frag] = []
    sure = {q: t for q, t in truths.items() if t[1] >= min_conf}
    if qa:
        labels = dict(zip(qa["intent"]["labels"], qa["intent"]["labels_pl"], strict=False))
        for q in qa["intent"]["questions"]:
            if q["id"] in sure:
                lab, p = sure[q["id"]]
                out.append(Frag(0, q["text"], "intencja", labels.get(lab, lab), "en", "consensus", q["id"], p))
        for q in qa["knowledge"]["questions"]:
            if q["id"] in sure:
                ans, p = sure[q["id"]]
                out.append(Frag(0, q["pl"], "prawdziwe", ans, "pl", "consensus", q["id"], p))
    if lex:
        names = _cat_names(lex)
        words = {q["id"]: q for q in lex["questions"]}
        for qid, (ans, p) in sure.items():
            m = re.fullmatch(r"(w(?:\d{5}|[a-z]\d{4}))c(\d{3})", qid)
            if m and ans == "tak" and m.group(1) in words and int(m.group(2)) < len(names):
                w = words[m.group(1)]
                out.append(Frag(0, w["word"], "jest", names[int(m.group(2))], w["lang"], "consensus", qid, p))
    if pairs:
        for qid, (ans, p) in sure.items():
            if qid in pairs and ans == "tak":
                out.append(Frag(0, pairs[qid]["pl"], "tlumaczenie", pairs[qid]["en"], "pl", "captcha", qid, p))
    if fashion_pl:
        for qid, (ans, p) in sure.items():
            m = re.fullmatch(r"(cg(?:\d{5}|[a-z]\d{4}))k(\d)", qid)
            if m and ans == "tak":
                out.append(
                    Frag(0, f"obraz {m.group(1)}", "przedstawia", fashion_pl[int(m.group(2))], "pl", "captcha", qid, p)
                )
    for u in user_qs:
        t = sure.get(u["id"])
        if not t:
            continue
        ans, p = t
        kind = u["kind"]
        if kind == "fact":
            out.append(Frag(0, u["text"], "prawdziwe", ans, "pl", "teach", u["id"], p))
        elif kind == "qa" and ans == "tak" and u.get("answer"):
            out.append(Frag(0, u["text"], "odpowiedz", u["answer"], "pl", "teach", u["id"], p))
        elif kind == "example":
            lab = (
                dict(zip(qa["intent"]["labels"], qa["intent"]["labels_pl"], strict=False)).get(ans, ans) if qa else ans
            )
            out.append(Frag(0, u["text"], "intencja", lab, "pl", "teach", u["id"], p))
        elif kind == "word" and lex:
            names = {c["id"]: c["pl"] for c in lex["taxonomy"]}
            out.append(Frag(0, u["text"], "jest", names.get(ans, ans), "pl", "teach", u["id"], p))
    return out


# ---------- warstwy 1–2: łączenie ----------


def _is_entity(s: str) -> bool:
    return 0 < len(norm(s).split()) <= CONCEPT_MAX_WORDS


def concept(label: str, lang: str = "pl") -> Frag:
    return Frag(1, label.strip(), "pojecie", "", lang, "link")


def topic(label: str) -> Frag:
    return Frag(2, label.strip(), "temat", "", "pl", "link")


def build(frags: Iterable[Frag], lex: Mapping[str, Any] | None = None) -> Graph:
    """Strzępki → pojęcia (ta sama encja) → tematy (korzeń is-a). Deterministyczne."""
    g = Graph()
    frags = [g.add(f) for f in frags if f.layer == 0]
    # hierarchia kategorii: nazwa → rodzic (z taksonomii + strzępków „X jest Y” między kategoriami)
    parent: dict[str, str] = {}
    if lex:
        byid = {c["id"]: c for c in lex["taxonomy"]}
        for c in lex["taxonomy"]:
            if c["parent"]:
                parent[norm(c["pl"])] = byid[c["parent"]]["pl"]
    cats = set(parent) | {norm(p) for p in parent.values()}

    def root(name: str) -> str:
        seen = set()
        while norm(name) in parent and norm(name) not in seen:
            seen.add(norm(name))
            name = parent[norm(name)]
        return name

    for f in frags:
        trust = f.hint if f.hint is not None else 0.8
        if _is_entity(f.subj):
            cs = g.add(concept(f.subj, f.lang))
            g.link(f, cs, "part_of", trust)
        else:
            cs = None
        if f.rel == "jest" and f.obj:
            co = g.add(concept(f.obj, "pl"))
            g.link(f, co, "supports", trust)
            if cs:
                g.link(cs, co, "is_a", trust)
            t = g.add(topic(root(f.obj) if norm(f.obj) in cats else f.obj))
            g.link(co, t, "part_of", 1.0)
            if cs and norm(f.subj) in cats:
                g.link(cs, g.add(topic(root(f.subj))), "part_of", 1.0)
        elif f.rel == "tlumaczenie" and f.obj and cs:
            ce = g.add(concept(f.obj, "en"))
            g.link(f, ce, "part_of", trust)
            g.link(cs, ce, "translation", trust)
            g.link(cs, g.add(topic("Słownik PL↔EN")), "part_of", 1.0)
        elif f.rel == "intencja":
            ci = g.add(concept(f.obj, "pl"))
            g.link(f, ci, "supports", trust)
            g.link(ci, g.add(topic("Intencje IoT")), "part_of", 1.0)
        elif f.rel in ("populacja", "stolica", "powierzchnia", "rok", "wysokosc") and cs:
            g.link(cs, g.add(topic("Geografia i fakty")), "part_of", 1.0)
        elif f.rel == "przedstawia":
            co = g.add(concept(f.obj, "pl"))
            g.link(f, co, "supports", trust)
            g.link(co, g.add(topic("Ubranie")), "part_of", 1.0)
        elif f.rel in ("prawdziwe", "odpowiedz"):
            g.link(f, g.add(topic("Fakty ogólne")), "part_of", trust)
        elif f.rel == "definicja" and cs:
            g.link(cs, g.add(topic("Słownik PL↔EN")), "part_of", 0.5)
    # synonimy: pojęcia PL o tym samym tłumaczeniu EN
    by_en: dict[str, list[Frag]] = defaultdict(list)
    for (_a, b, kind), link in g.links.items():
        if kind == "translation":
            by_en[b].append(link.src)
    for group in by_en.values():
        group = sorted(group, key=lambda f: f.key)
        for i, a in enumerate(group):
            for b in group[i + 1 :]:
                g.link(a, b, "synonym", 0.7)
    return g


def conflicts(frags: Iterable[Frag]) -> list[list[Frag]]:
    """Ta sama encja i relacja funkcyjna, różne wartości → grupy do rozstrzygnięcia w Weryfikuj."""
    groups: dict[tuple[str, str], dict[str, Frag]] = defaultdict(dict)
    for f in frags:
        if f.layer == 0 and f.rel in FUNCTIONAL:
            groups[(norm(f.subj), f.rel)].setdefault(norm(f.obj), f)
    return [sorted(v.values(), key=lambda f: f.key) for v in groups.values() if len(v) > 1]


def chain(g: Graph, start_key: str, max_depth: int = 3) -> list[Frag]:
    """Nić od strzępka w górę warstw (strzępek → pojęcie → temat) – do cytowania w czacie."""
    path = [g.frags[start_key]]
    cur = start_key
    for _ in range(max_depth):
        up = sorted(
            (lk for (a, _b, kind), lk in g.links.items() if a == cur and kind in ("part_of", "is_a", "supports")),
            key=lambda lk: (-lk.dst.layer, lk.dst.key),
        )
        up = [lk for lk in up if lk.dst.layer > path[-1].layer or lk.kind == "is_a"]
        if not up:
            break
        nxt = up[0].dst
        if nxt in path:
            break
        path.append(nxt)
        cur = nxt.key
    return path


def batches(g: Graph, size: int = 200, link_size: int = 350) -> Iterable[tuple[list[dict], list[dict]]]:
    """Paczki do RPC ``myc_frag_add``: najpierw warstwami strzępki, potem łącza (po kluczach)."""
    fr = sorted(g.frags.values(), key=lambda f: (f.layer, f.key))
    for i in range(0, len(fr), size):
        yield [f.json() for f in fr[i : i + size]], []
    ln = sorted(g.links.values(), key=lambda lk: (lk.src.key, lk.dst.key, lk.kind))
    for i in range(0, len(ln), link_size):
        yield [], [lk.json() for lk in ln[i : i + link_size]]
