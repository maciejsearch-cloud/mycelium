"""Samoorganizująca się taksonomia słów (węzeł grzybni, tylko PyTorch – bez numpy).

Słowa ze słowników (OEWN, plWordNet) grupowane BEZ etykiet: osadzenie MiniLM + najbliższe hiperonimy.
Rekurencyjny sferyczny k-means: tematy → kategorie → podkategorie → strzępki (najmniejsze grupy).
Gałąź dzieli się tylko, gdy podział naprawdę poprawia spójność; zbyt małe grupy łączą się z najbliższym
rodzeństwem. Nazwy grup: najczęstszy wspólny hiperonim członków (PL, gdy jest w plWordNecie), inaczej
słowo najbliższe środkowi grupy.

Poprawki właścicielki (zakładka Weryfikuj, item_type = 'category'):
* przenieś słowo  – ``truth = "c:<wersja>:<id>"``: słowo trafia do grupy najbardziej pokrywającej się z tamtą,
* zmień nazwę     – ``truth = "name:<tekst>"`` dla ``ref = "tc:<wersja>:<id>"``: nazwa przechodzi na następcę grupy,
* połącz          – ``truth = "merge:<wersja>:<id>"``: następcy obu grup są łączeni,
* podziel/odrzuć  – ``truth = "split"`` albo werdykt reject: następca grupy jest dzielony.
Poprawki dotyczą tylko słów spoza stałego zbioru oceny (ocena zostaje uczciwa).

Ocena (stała, odcisk sha256 w meta.json): złote kategorie WordNetu (31) – NMI i czystość na poziomie
kategorii oraz trafność: liść → większościowa złota kategoria jego słów SPOZA zbioru oceny, sprawdzana na
słowach zbioru oceny. Metryki liczy się z samego przypisania, więc każdy może je przeliczyć (weryfikator).
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict

try:  # weryfikator CI liczy metryki bez PyTorcha (tylko z przypisania)
    import torch
except ImportError:  # pragma: no cover
    torch = None

PARAMS = [  # przestrzeń, którą węzły przeszukują kolejno (bramka zostawia tylko lepsze wersje)
    {"beta": 1.0, "k1": 12, "min": 30, "frag": 14},
    {"beta": 2.0, "k1": 10, "min": 30, "frag": 14},
    {"beta": 3.0, "k1": 10, "min": 30, "frag": 14},
    {"beta": 4.0, "k1": 10, "min": 30, "frag": 14},
    {"beta": 3.0, "k1": 20, "min": 20, "frag": 10},
    {"beta": 5.0, "k1": 16, "min": 20, "frag": 10},
    {"beta": 6.0, "k1": 16, "min": 20, "frag": 10},
    {"beta": 5.0, "k1": 20, "min": 15, "frag": 8},
    {"beta": 0.0, "k1": 16, "min": 20, "frag": 10},
]
# z drzewem seed (WordNet/plWordNet/Wikidata): kategorie nazwane źródłem, grupy automatyczne tylko pod nimi
SEED_PARAMS = [
    {"beta": 6.0, "k1": 10, "min": 30, "frag": 20, "seed": 1},
    {"beta": 4.0, "k1": 10, "min": 30, "frag": 14, "seed": 1},
    {"beta": 8.0, "k1": 10, "min": 30, "frag": 24, "seed": 1},
    {"beta": 2.0, "k1": 10, "min": 30, "frag": 10, "seed": 1},
]
LEVELS = ("temat", "kategoria", "podkategoria", "strzępek")


class Inputs:
    def __init__(self, inputs: dict, emb: bytes, seed: dict | None = None):
        self.raw = inputs
        # kuratorowane drzewo kategorii (scripts/build_seed_taxonomy.py): nazwy PL z pochodzeniem + słowo → kategoria
        self.seed = seed if seed and len(seed.get("map", [])) == len(inputs["words"]) else None
        self.words = [tuple(w) for w in inputs["words"]]
        self.n = len(self.words)
        e = torch.frombuffer(bytearray(emb), dtype=torch.int8).view(self.n, 384).float()
        self.E = torch.nn.functional.normalize(e, dim=1)
        hy = inputs["hyper"]
        self.hnames = hy["names"]
        self.V = len(self.hnames)
        ptr, idx = hy["ptr"], hy["idx"]
        self.rows = [idx[ptr[i] : ptr[i + 1]] for i in range(self.n)]
        df = Counter(h for r in self.rows for h in r)
        self.df = df
        rr, cc, vv = [], [], []
        for i, r in enumerate(self.rows):
            if not r:
                continue
            w = [math.log(self.n / df[h]) for h in r]
            s = math.sqrt(sum(x * x for x in w))
            for h, x in zip(r, w, strict=True):
                rr.append(i)
                cc.append(h)
                vv.append(x / s)
        self.Hd = torch.zeros(self.n, self.V)
        if rr:
            self.Hd[torch.tensor(rr), torch.tensor(cc)] = torch.tensor(vv)  # n × V (ok. 65 MB dla 10 868 × 1504)
        self.gold = inputs["gold"]
        self.eval = set(inputs["eval"])
        self.tax = inputs["taxonomy"]


def _feat(inp: Inputs, beta: float, idx: torch.Tensor) -> torch.Tensor:
    x = inp.E[idx]
    if beta > 0:
        x = torch.cat([x, math.sqrt(beta) * inp.Hd[idx]], 1)
    return torch.nn.functional.normalize(x, dim=1)


def kmeans(x: torch.Tensor, k: int, seed: int, iters: int = 30) -> tuple[torch.Tensor, torch.Tensor]:
    """Sferyczny k-means z inicjalizacją k-means++ (ziarno → wynik odtwarzalny)."""
    g = torch.Generator().manual_seed(seed)
    n = x.shape[0]
    c = [int(torch.randint(n, (1,), generator=g))]
    d = 1 - x @ x[c[0]]
    for _ in range(1, k):
        p = d.clamp(min=0) ** 2
        if float(p.sum()) <= 0:
            break
        c.append(int(torch.multinomial(p / p.sum(), 1, generator=g)))
        d = torch.minimum(d, 1 - x @ x[c[-1]])
    C = x[c].clone()
    a = torch.zeros(n, dtype=torch.long)
    for _ in range(iters):
        s = x @ C.T
        na = s.argmax(1)
        if _ and torch.equal(na, a):
            break
        a = na
        for j in range(C.shape[0]):
            m = a == j
            if m.any():
                C[j] = torch.nn.functional.normalize(x[m].mean(0), dim=0)
    return a, C


def cohesion(x: torch.Tensor) -> float:
    if x.shape[0] < 2:
        return 1.0
    c = torch.nn.functional.normalize(x.mean(0), dim=0)
    return float((x @ c).mean())


class Builder:
    def __init__(self, inp: Inputs, params: dict, corr: dict | None = None, seed: int = 7):
        self.inp, self.p, self.seed = inp, params, seed
        self.corr = corr or {}
        # słowa zgłoszone jako „to nie jest słowo / błąd w słowniku” – nie reprezentują grup (top, nazwy)
        self.bad: set[int] = set(self.corr.get("bad", []))
        self.nodes: list[dict] = []
        self.margin = [0.0] * inp.n
        self.leaf = [-1] * inp.n

    def _match(self, members: set[int], target: set[int]) -> float:
        if not target:
            return 0.0
        return len(members & target) / len(members | target)

    def _wants_split(self, mem: set[int]) -> bool:
        return any(self._match(mem, s) >= 0.5 for s in self.corr.get("split", []))

    def build(self) -> None:
        if self.p.get("seed") and self.inp.seed:
            self._seed_build()
            self._merge_owner()
            self._seed_name()
            return
        self._split(torch.arange(self.inp.n), -1, -1)
        self._merge_owner()
        self._name()

    # ---------------------------------------------------------------- tryb seed
    def _seed_build(self) -> None:
        """Drzewo kategorii z otwartych źródeł jako szkielet; grupy automatyczne tylko wewnątrz kategorii.

        Słowa spoza zbioru oceny z kategorią seed (zgodne znaczenia) → ta kategoria (albo poprawka właścicielki /
        głosowanie). Pozostałe (w tym CAŁY zbiór oceny – bez podglądania etykiet) schodzą po drzewie do najbliższego
        środka kategorii w przestrzeni cech (osadzenie + hiperonimy). Margines = różnica dwóch najlepszych dopasowań."""
        inp, p = self.inp, self.p
        cats, smap = inp.seed["cats"], inp.seed["map"]
        x = _feat(inp, p["beta"], torch.arange(inp.n))
        kids: dict[int, list[int]] = defaultdict(list)
        for c in cats:
            kids[c["parent"]].append(c["id"])
        assign = [-1] * inp.n
        picks = self.corr.get("seed_pick", {})
        for i in range(inp.n):
            if i in inp.eval:
                continue
            if i in picks and 0 <= picks[i] < len(cats):
                assign[i] = picks[i]
            elif smap[i] >= 0 and i not in self.bad:
                assign[i] = smap[i]
        # przeniesienia słów (poprawki): kategoria większości członków celu
        for w, target in self.corr.get("pins", {}).items():
            if w in inp.eval or w in picks:
                continue
            votes = Counter(assign[t] for t in target if t != w and assign[t] >= 0)
            if votes:
                assign[w] = votes.most_common(1)[0][0]
        # środki: suma cech słów przypisanych w poddrzewie i bezpośrednio w kategorii
        D = x.shape[1]
        sub = torch.zeros(len(cats), D)
        own = torch.zeros(len(cats), D)
        n_own = [0] * len(cats)
        for i, a in enumerate(assign):
            if a >= 0:
                own[a] += x[i]
                n_own[a] += 1
        sub += own
        for c in reversed(cats):  # dzieci po rodzicach (porządek po poziomie)
            if c["parent"] >= 0:
                sub[c["parent"]] += sub[c["id"]]
        subn = torch.nn.functional.normalize(sub, dim=1)
        ownn = torch.nn.functional.normalize(own, dim=1)
        roots = kids[-1]
        for i in range(inp.n):
            if assign[i] >= 0:
                self.margin[i] = 1.0
                continue
            cands = roots
            cur = -1
            while True:
                opts = [(float(subn[c] @ x[i]), c, "sub") for c in cands]
                if cur >= 0 and n_own[cur]:
                    opts.append((float(ownn[cur] @ x[i]), cur, "own"))
                if not opts:
                    break
                opts.sort(reverse=True)
                self.margin[i] = opts[0][0] - (opts[1][0] if len(opts) > 1 else 0.0)
                s0, c0, kind = opts[0]
                if kind == "own":
                    break
                cur = c0
                cands = kids[c0]
            assign[i] = cur
        # węzły: kategorie seed (te same id co w seed, rodzice przed dziećmi), potem grupy automatyczne
        members: dict[int, list[int]] = defaultdict(list)
        for i, a in enumerate(assign):
            c = a
            while c >= 0:
                members[c].append(i)
                c = cats[c]["parent"]
        remap: dict[int, int] = {}
        for c in cats:
            if not members[c["id"]]:
                continue
            idx = torch.tensor(members[c["id"]])
            par = remap.get(c["parent"], -1)
            nid = self._node(par, c["lvl"], idx, x[idx])
            self.nodes[nid]["seed"] = c["id"]
            remap[c["id"]] = nid
        direct: dict[int, list[int]] = defaultdict(list)
        for i, a in enumerate(assign):
            direct[remap[a]].append(i)
        for nid, ws in direct.items():
            nd = self.nodes[nid]
            idx = torch.tensor(ws)
            has_kids = any(m["p"] == nid for m in self.nodes)
            k = max(2, min(12, len(ws) // p["frag"]))
            if has_kids or len(ws) < 2 * p["frag"]:
                self._seed_leaf(nid, ws)
                continue
            xs = x[idx]
            best = None
            for r in range(p.get("restarts", 3)):
                a, C = kmeans(xs, k, self.seed + 7919 * r + len(ws))
                obj = float((xs * C[a]).sum())
                if best is None or obj > best[0]:
                    best = (obj, a, C)
            _, a, C = best
            groups = [j for j in range(C.shape[0]) if int((a == j).sum()) >= max(4, p["frag"] // 2)]
            gain = sum(cohesion(xs[a == j]) * int((a == j).sum()) for j in groups) / max(1, len(ws)) - cohesion(xs)
            if len(groups) < 2 or gain < p.get("gain", 0.02):
                self._seed_leaf(nid, ws)
                continue
            # małe resztki do najbliższej zachowanej grupy
            sim = xs @ C[groups].T
            a = torch.tensor(groups)[sim.argmax(1)]
            for j in groups:
                sel = idx[a == j]
                cid = self._node(nid, nd["lvl"] + 1, sel, x[sel])
                self._seed_leaf(cid, sel.tolist())

    def _seed_leaf(self, nid: int, ws: list[int]) -> None:
        self.nodes[nid]["leaf"] = all(m["p"] != nid for m in self.nodes)
        for i in ws:
            self.leaf[i] = nid

    def _seed_name(self) -> None:
        """Nazwy: kategoria seed → jej polska nazwa ze źródłem; grupa automatyczna → bez nazwy (tylko wewnętrznie),
        chyba że ma nazwę nadaną przez człowieka (Weryfikuj)."""
        cats = self.inp.seed["cats"]
        renames = self.corr.get("names", [])
        for nd in self.nodes:
            if "seed" in nd:
                c = cats[nd["seed"]]
                nd["name_pl"], nd["name_en"], nd["src"] = c["pl"], c["en"], "seed"
                mem = [i for i in nd["members"] if i not in self.inp.eval]
                agree = sum(1 for i in mem if self.inp.seed["map"][i] >= 0)
                nd["cov"] = round(agree / max(1, len(mem)), 3)
                for k in ("qid", "label_src"):
                    if k in c:
                        nd[k] = c[k]
                continue
            tops = list(dict.fromkeys(self.inp.words[i][0] for i in nd["top"] if i not in self.bad))[:3]
            nd["name_pl"] = nd["name_en"] = "≈ " + ", ".join(tops)
            nd["cov"], nd["src"] = 0.0, "auto"
            for S, name in renames:
                if self._match(set(nd["members"]), S) >= 0.5:
                    nd["name_pl"] = nd["name_en"] = name
                    nd["owner_name"], nd["src"] = True, "owner"

    def _split(self, idx: torch.Tensor, parent: int, lvl: int) -> None:
        """Grupa ``idx`` na poziomie ``lvl`` (-1 = korzeń, bez węzła): utwórz węzeł i ewentualnie podziel."""
        p = self.p
        n = idx.numel()
        x = _feat(self.inp, p["beta"], idx)
        me = self._node(parent, lvl, idx, x) if lvl >= 0 else -1
        child = lvl + 1
        if child == 0:
            k = p["k1"]
        elif child < 3:
            k = max(2, min(6, round(math.sqrt(n / (p["min"] * 1.5)))))
        else:
            k = max(2, min(12, n // p["frag"]))
        forced = lvl >= 0 and self._wants_split(set(idx.tolist()))
        too_small = n < 2 * (p["min"] if child < 3 else p["frag"])
        if child > 3 or (too_small and not forced) or n < 4:
            self._leaf(me, idx)
            return
        best = None
        for r in range(p.get("restarts", 3)):
            a, C = kmeans(x, k, self.seed + 7919 * r + 1009 * child + n)
            obj = float((x * C[a]).sum())
            if best is None or obj > best[0]:
                best = (obj, a, C)
        _, a, C = best
        a = self._pins(idx, a)
        minsz = p["min"] if child < 3 else max(4, p["frag"] // 2)
        for _ in range(k):
            cnt = torch.bincount(a, minlength=C.shape[0])
            small = [j for j in range(C.shape[0]) if 0 < cnt[j] < minsz]
            if not small or (cnt > 0).sum() <= 1:
                break
            j = small[0]
            sim = C @ C[j]
            sim[j] = -9
            sim[cnt == 0] = -9
            a[a == j] = int(sim.argmax())
        groups = [j for j in range(C.shape[0]) if (a == j).any()]
        if len(groups) <= 1:
            self._leaf(me, idx)
            return
        # podział tylko, gdy poprawia spójność (średni kosinus do środka grupy), chyba że właścicielka kazała
        before = cohesion(x)
        after = sum(cohesion(x[a == j]) * int((a == j).sum()) for j in groups) / n
        if child > 0 and not forced and after - before < p.get("gain", 0.02):
            self._leaf(me, idx)
            return
        s = x @ C[groups].T
        top2 = s.topk(min(2, len(groups)), 1).values
        for i, w in zip(idx.tolist(), (top2[:, 0] - top2[:, -1]).tolist(), strict=True):
            self.margin[i] = w
        for j in groups:
            self._split(idx[a == j], me, child)

    def _pins(self, idx: torch.Tensor, a: torch.Tensor) -> torch.Tensor:
        """Przeniesienia słów: słowo idzie do grupy, w której jest większość członków grupy docelowej."""
        pins = self.corr.get("pins", {})
        if not pins:
            return a
        pos = {w: i for i, w in enumerate(idx.tolist())}
        for w, target in pins.items():
            if w not in pos or w in self.inp.eval:
                continue
            votes = Counter(int(a[pos[t]]) for t in target if t in pos and t != w)
            if votes:
                a[pos[w]] = votes.most_common(1)[0][0]
        return a

    def _node(self, parent: int, lvl: int, idx: torch.Tensor, x: torch.Tensor) -> int:
        c = torch.nn.functional.normalize(x.mean(0), dim=0)
        sims = x @ c
        order = idx[sims.argsort(descending=True)].tolist()
        top = [i for i in order if i not in self.bad][:8] or order[:8]
        self.nodes.append(
            {
                "id": len(self.nodes),
                "p": parent,
                "lvl": lvl,
                "n": idx.numel(),
                "coh": round(float(sims.mean()), 4),
                "top": top,
                "members": idx.tolist(),
            }
        )
        return len(self.nodes) - 1

    def _leaf(self, me: int, idx: torch.Tensor) -> None:
        if me < 0:  # cały zbiór bez podziału
            me = self._node(-1, 0, idx, _feat(self.inp, self.p["beta"], idx))
        self.nodes[me]["leaf"] = True
        for i in idx.tolist():
            self.leaf[i] = me

    def _merge_owner(self) -> None:
        for A, B in self.corr.get("merge", []):
            best = []
            for S in (A, B):
                m = max(self.nodes, key=lambda nd: self._match(set(nd["members"]), S))
                best.append(m if self._match(set(m["members"]), S) >= 0.4 else None)
            a, b = best
            if not a or not b or a is b or a["p"] != b["p"]:
                continue
            # b znika: jego liście/dzieci przechodzą pod a
            for nd in self.nodes:
                if nd["p"] == b["id"]:
                    nd["p"] = a["id"]
            for i in b["members"]:
                if self.leaf[i] == b["id"]:
                    self.leaf[i] = a["id"]
            a["members"] = sorted(set(a["members"]) | set(b["members"]))
            a["n"] = len(a["members"])
            a["leaf"] = all(self.leaf[i] == a["id"] for i in a["members"])
            b["gone"] = True
            a["merged"] = True
        if any(nd.get("gone") for nd in self.nodes):
            keep = [nd for nd in self.nodes if not nd.get("gone")]
            remap = {nd["id"]: i for i, nd in enumerate(keep)}
            for nd in keep:
                nd["id"] = remap[nd["id"]]
                nd["p"] = remap.get(nd["p"], -1) if nd["p"] >= 0 else -1
            self.leaf = [remap[x] for x in self.leaf]
            self.nodes = keep

    def _name(self) -> None:
        inp = self.inp
        renames = self.corr.get("names", [])
        used: dict[int, set[str]] = defaultdict(set)
        for nd in self.nodes:
            mem = [i for i in nd["members"] if i not in self.bad] or nd["members"]
            cnt = Counter(h for i in mem for h in inp.rows[i])
            best, best_pl, cov = None, None, 0.0
            for h, c in cnt.most_common(40):
                share = c / len(mem)
                # specyficzność: rzadszy hiperonim przy podobnym pokryciu wygrywa
                score = share * (1 + 0.15 * math.log(inp.n / inp.df[h]))
                if share >= 0.25 and (best is None or score > best[1]):
                    best = (h, score)
                    cov = share
                # nazwa polska: najlepszy hiperonim, który ma polską nazwę (zamiast angielskiej, gdy polska istnieje)
                if share >= 0.25 and inp.hnames[h][1] and (best_pl is None or score > best_pl[1]):
                    best_pl = (h, score)
            if best:
                en, pl = inp.hnames[best[0]]
                pl = pl or (inp.hnames[best_pl[0]][1] if best_pl else "") or self._gold_pl(mem) or en
                nd["name_en"], nd["name_pl"], nd["cov"], nd["hyper"] = en, pl, round(cov, 3), best[0]
            else:
                # brak wspólnego hiperonimu: czytelna nazwa z najbardziej typowych członków (medoid + 2 kolejne)
                tops = list(dict.fromkeys(inp.words[i][0] for i in nd["top"] if i not in self.bad))[:3] or [
                    inp.words[nd["top"][0]][0]
                ]
                nd["name_en"] = nd["name_pl"] = "≈ " + ", ".join(tops)
                nd["cov"] = 0.0
            if nd["name_pl"] in used[nd["p"]]:
                w = inp.words[nd["top"][0]][0]
                nd["name_pl"], nd["name_en"] = f"{nd['name_pl']} ({w})", f"{nd['name_en']} ({w})"
            used[nd["p"]].add(nd["name_pl"])
            for S, name in renames:
                if self._match(set(mem), S) >= 0.5:
                    nd["name_pl"] = nd["name_en"] = name
                    nd["owner_name"] = True
            nd["src"] = "owner" if nd.get("owner_name") else "hyper" if best else "medoid"

    def _gold_pl(self, mem: list[int]) -> str:
        """Polska nazwa z kategorii słownikowej większości członków spoza zbioru oceny (gdy hiperonim nie ma polskiej nazwy)."""
        inp = self.inp
        cnt = Counter(inp.gold[i] for i in mem if i not in inp.eval)
        if not cnt:
            return ""
        g, c = cnt.most_common(1)[0]
        return inp.tax[g]["pl"].lower() if c / sum(cnt.values()) >= 0.5 else ""

    def result(self) -> dict:
        nodes = [{k: v for k, v in nd.items() if k != "members"} for nd in self.nodes]
        out = {"nodes": nodes, "leaf": self.leaf, "margin": [round(m, 3) for m in self.margin]}
        if self.corr.get("own"):
            out["own"] = {str(w): name for w, name in self.corr["own"].items()}
        if self.bad:
            out["bad"] = sorted(self.bad)
        return out


# ---------------------------------------------------------------- ocena (tylko z przypisania)
def ancestors(nodes: list[dict], leaf: int) -> list[int]:
    out = [leaf]
    while nodes[out[-1]]["p"] >= 0:
        out.append(nodes[out[-1]]["p"])
    return out[::-1]  # od tematu do liścia


def nmi(a: list, b: list) -> float:
    n = len(a)
    ca, cb, cab = Counter(a), Counter(b), Counter(zip(a, b, strict=True))
    mi = sum(c / n * math.log(c * n / (ca[x] * cb[y])) for (x, y), c in cab.items())
    ha = -sum(c / n * math.log(c / n) for c in ca.values())
    hb = -sum(c / n * math.log(c / n) for c in cb.values())
    return mi / math.sqrt(ha * hb) if ha > 0 and hb > 0 else 0.0


def purity(a: list, b: list) -> float:
    by = defaultdict(Counter)
    for x, y in zip(a, b, strict=True):
        by[x][y] += 1
    return sum(c.most_common(1)[0][1] for c in by.values()) / len(a)


def metrics(res: dict, gold: list[int], ev: list[int] | set[int]) -> dict:
    nodes, leaf = res["nodes"], res["leaf"]
    ev = set(ev)
    paths = [ancestors(nodes, x) for x in leaf]
    lv = lambda L: [p[min(L, len(p) - 1)] for p in paths]  # noqa: E731
    cat = lv(1)
    # liść → większość złotych etykiet słów spoza oceny (rodzic, gdy liść ma tylko słowa oceny)
    votes: dict[int, Counter] = defaultdict(Counter)
    for i, p in enumerate(paths):
        if i not in ev:
            for nd in p:
                votes[nd][gold[i]] += 1
    hit = 0
    for i in ev:
        pred = None
        for nd in reversed(paths[i]):
            if votes[nd]:
                pred = votes[nd].most_common(1)[0][0]
                break
        hit += pred == gold[i]
    leaves = [nd for nd in nodes if nd.get("leaf")]
    return {
        "acc": round(hit / len(ev), 6),
        "nmi_cat": round(nmi(cat, gold), 6),
        "purity_cat": round(purity(cat, gold), 6),
        "nmi_top": round(nmi(lv(0), gold), 6),
        "nmi_leaf": round(nmi(leaf, gold), 6),
        "n_nodes": len(nodes),
        "n_leaves": len(leaves),
        "by_level": dict(Counter(LEVELS[min(nd["lvl"], 3)] for nd in nodes)),
        "named_hyper": round(sum(1 for nd in nodes if nd.get("src") == "hyper") / max(1, len(nodes)), 4),
        "named_seed": round(sum(1 for nd in nodes if nd.get("src") == "seed") / max(1, len(nodes)), 4),
        "eval_n": len(ev),
    }


def eval_sha(inputs: dict) -> str:
    w, g = inputs["words"], inputs["gold"]
    return hashlib.sha256(",".join(f"{w[i][1]}:{w[i][0]}:{g[i]}" for i in inputs["eval"]).encode()).hexdigest()


# ---------------------------------------------------------------- poprawki właścicielki
def corrections(labels: list[dict], versions: dict[int, dict], inp: Inputs | None = None) -> dict:
    """Etykiety z myc_review_labels (item_type='category') → zbiory członków ze wskazanych wersji.

    Słowo (tw:<i>): ``c:<v>:<id>`` grupa, ``g:<id>`` kategoria WordNet, ``h:<idx>`` hiperonim,
    ``own:<nazwa>|<rodzic>`` własna kategoria, odrzucenie z ``notword`` = błąd w słowniku."""

    def members(ver: int, nid: int) -> set[int]:
        res = versions.get(ver)
        if not res:
            return set()
        out = set()
        sub = {nid}
        nodes = res["nodes"]
        for nd in nodes:  # potomkowie (rodzice mają mniejsze id)
            if nd["p"] in sub:
                sub.add(nd["id"])
        for i, lf in enumerate(res["leaf"]):
            if lf in sub:
                out.add(i)
        return out

    def parse_c(s: str):
        try:
            _, v, i = s.split(":")
            return int(v), int(i)
        except ValueError:
            return None

    def target(tr: str) -> set[int] | None:
        """Cel przeniesienia słowa: grupa wersji (c:v:id), kategoria WordNet (g:id) albo hiperonim (h:idx)."""
        if tr.startswith("c:"):
            c = parse_c(tr)
            return members(*c) if c else None
        if inp is not None and tr.startswith("g:"):
            ids = [k for k, t in enumerate(inp.tax) if t["id"] == tr[2:]]
            return {i for i, g in enumerate(inp.gold) if ids and g == ids[0]} or None
        if inp is not None and tr.startswith("h:") and tr[2:].isdigit():
            h = int(tr[2:])
            return {i for i, r in enumerate(inp.rows) if h in r} or None
        return None

    # poprawki słów ważone zaufaniem: etykieta właścicielki (owner) rozstrzyga od razu, pozostałe muszą
    # razem uzbierać wagę >= 1 dla tego samego celu (np. dwie zaufane osoby po 0,5)
    votes: dict[int, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    owner: dict[int, str] = {}
    bad_w: dict[int, float] = defaultdict(float)
    bad_owner: set[int] = set()
    names, merges, splits = [], [], []
    for lb in labels:
        if lb.get("item_type") != "category":
            continue
        ref, tr, verdict = lb["item_ref"], (lb.get("truth") or "").strip(), lb.get("verdict")
        wt = float(lb.get("weight") if lb.get("weight") is not None else 1.0)
        is_owner = lb.get("reviewer", "owner") == "owner"
        if ref.startswith("tw:"):  # słowo: tw:<idx>
            try:
                w = int(ref.split(":")[1])
            except ValueError:
                continue
            if verdict == "reject" and tr == "notword":
                if is_owner:
                    bad_owner.add(w)
                bad_w[w] += wt
            elif verdict == "correct" and tr:
                if is_owner:
                    owner[w] = tr
                votes[w][tr] += wt
        elif ref.startswith("tc:"):  # grupa: tc:<wersja>:<id>
            c = parse_c(ref)
            if not c:
                continue
            S = members(*c)
            if verdict == "reject" or tr == "split":
                splits.append(S)
            elif tr.startswith("name:") and len(tr) > 5:
                names.append((S, tr[5:].strip()[:60]))
            elif tr.startswith("merge:"):
                d = parse_c(tr.replace("merge:", "c:", 1))
                if d:
                    merges.append((S, members(*d)))
            elif verdict == "approve":
                nd = versions.get(c[0], {}).get("nodes", [])
                if c[1] < len(nd):
                    names.append((S, nd[c[1]]["name_pl"]))
    chosen: dict[int, str] = {}
    for w, vs in votes.items():
        if w in owner:
            chosen[w] = owner[w]
        else:
            tr, tot = max(vs.items(), key=lambda kv: kv[1])
            if tot >= 1.0 - 1e-9:
                chosen[w] = tr
    # własne kategorie: own:<nazwa>|<rodzic>; słowa z tą samą nazwą trzymają się razem, rodzic wskazuje miejsce w drzewie
    own: dict[int, str] = {}
    parent: dict[int, str] = {}
    for w, tr in chosen.items():
        if tr.startswith("own:"):
            name, _, par = tr[4:].partition("|")
            if name.strip():
                own[w] = name.strip()[:60]
                parent[w] = par.strip()
    by_name: dict[str, set[int]] = defaultdict(set)
    for w, name in own.items():
        by_name[name.casefold()].add(w)
    pins: dict[int, set[int]] = {}
    for w, tr in chosen.items():
        if w in own:
            S = (target(parent[w]) if parent[w] else None) or set()
            S = S | (by_name[own[w].casefold()] - {w})
            if S:
                pins[w] = S
        else:
            S = target(tr)
            if S:
                pins[w] = S
    bad = sorted(w for w, t in bad_w.items() if w in bad_owner or t >= 1.0 - 1e-9)
    # kategoria seed wskazana wprost (s:<id>) – w trybie seed słowo trafia do niej
    seed_pick = {w: int(tr[2:]) for w, tr in chosen.items() if tr.startswith("s:") and tr[2:].isdigit()}
    return {
        "pins": pins,
        "names": names,
        "merge": merges,
        "split": splits,
        "own": own,
        "bad": bad,
        "seed_pick": seed_pick,
    }


def corr_needs(labels: list[dict]) -> list[int]:
    """Wersje, których drzewa potrzeba do rozwinięcia poprawek."""
    out = set()
    for lb in labels:
        if lb.get("item_type") != "category":
            continue
        for s in (lb["item_ref"], lb.get("truth") or ""):
            parts = s.split(":")
            if s.startswith("own:"):
                parts = s.partition("|")[2].split(":")
            if len(parts) == 3 and parts[0] in ("tc", "c", "merge"):
                with_v = parts[1]
                if with_v.isdigit():
                    out.add(int(with_v))
    return sorted(out)


def build(inp: Inputs, params: dict, corr: dict | None = None) -> tuple[dict, dict]:
    b = Builder(inp, params, corr)
    b.build()
    res = b.result()
    return res, metrics(res, inp.gold, inp.eval)


def result_bytes(res: dict, meta: dict) -> bytes:
    return json.dumps({**meta, **res}, ensure_ascii=False, separators=(",", ":")).encode()
