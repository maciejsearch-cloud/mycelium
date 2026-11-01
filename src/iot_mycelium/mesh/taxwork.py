"""Praca węzła dla taksonomii słów: grupowanie (kandydaci), niezależne przeliczanie cudzych kandydatów, strzępki.

Cykl co ok. 15 min (CPU dzielony z czatem – ta sama blokada co odpowiedzi):
1. jest cudzy kandydat → pobierz jego przypisanie, przelicz metryki na stałym zbiorze oceny, zgłoś (myc_tax_verify),
2. brak kandydata → zbuduj taksonomię z kolejnymi ustawieniami (albo z nowymi poprawkami właściciela);
   zgłoś tylko, gdy trafność jest wyższa od opublikowanej (bramka w bazie sprawdza to jeszcze raz),
3. opublikowana wersja → pojęcia (kategorie) i tematy jako strzępki (myc_frag_add, idempotentnie).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import random
import re
import time

from . import taxo
from .lmwork import Supa, _http
from .qwen import cache_dir

DATA_URL = os.environ.get("MYC_TAXO_DATA", "https://maciejsearch-cloud.github.io/demo/mycelium/data/taxo/")
PERIOD = float(os.environ.get("MYC_TAXO_PERIOD", "900"))


class TaxoWorker:
    def __init__(self, node, log=print):
        self.node, self.log = node, log
        self.sb = Supa()
        self.inp: taxo.Inputs | None = None
        self.meta: dict | None = None
        self.versions: dict[int, dict] = {}
        self.dir = cache_dir() / "taxo"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.state_p = self.dir / f"state-{node.id[:8]}.json"
        try:
            self.state = json.loads(self.state_p.read_text())
        except (OSError, ValueError):
            self.state = {"tried": [], "frags": []}
        self.stats = {"taxo_built": 0, "taxo_verified": 0, "taxo_proposed": 0, "taxo_ms": 0}
        self.last_job: dict | None = None

    def _save(self):
        self.state_p.write_text(json.dumps(self.state))

    # ---------------------------------------------------------------- dane
    def _fetch(self, name: str) -> bytes:
        if not DATA_URL.startswith("http"):
            from pathlib import Path

            return (Path(DATA_URL) / name).read_bytes()
        return _http("GET", DATA_URL.rstrip("/") + "/" + name, timeout=300)

    def load(self) -> None:
        meta = json.loads(self._fetch("meta.json"))
        if self.inp is not None and self.meta == meta:
            return
        files = {}
        for name, sha in meta["files"].items():
            if not isinstance(name, str) or not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$", name) or ".." in name:
                raise ValueError(f"niedozwolona nazwa pliku: {name!r}")
            p = self.dir / name
            b = p.read_bytes() if p.exists() else b""
            if hashlib.sha256(b).hexdigest() != sha:
                b = self._fetch(name)
                if hashlib.sha256(b).hexdigest() != sha:
                    raise ValueError(f"suma SHA-256 nie zgadza się: {name}")
                p.write_bytes(b)
            files[name] = b
        inputs = json.loads(files["inputs.json"])
        if taxo.eval_sha(inputs) != meta["eval_sha"]:
            raise ValueError("odcisk zbioru oceny nie zgadza się")
        seed = json.loads(files["seed.json"]) if "seed.json" in files else None
        self.inp = taxo.Inputs(inputs, files["emb.bin"], seed)
        self.meta = meta

    def version(self, row: dict) -> dict:
        v = row["version"]
        if v not in self.versions:
            self.versions[v] = json.loads(self.sb.public(row["path"]))
        return self.versions[v]

    # ---------------------------------------------------------------- kroki
    def verify(self, cand: dict) -> dict:
        res = json.loads(self.sb.public(cand["path"]))
        m = taxo.metrics(res, self.inp.gold, self.inp.eval)
        r = self.sb.rpc("myc_tax_verify", {"p_node": self.node.id, "p_id": cand["id"], "p_acc": m["acc"]})
        self.stats["taxo_verified"] += 1
        self.log(
            f"taksonomia: przeliczyłem kandydata v{cand['version']} – trafność {m['acc']:.4f} (zgłoszona {cand['acc']:.4f}) → {r}"
        )
        return {"kind": "verify", "version": cand["version"], "acc": m["acc"], "res": r}

    def propose(self, rows: list[dict]) -> dict | None:
        pub = [r for r in rows if r["status"] == "published"]
        cur = max(pub, key=lambda r: r["version"]) if pub else None
        labels = [x for x in self.sb.rpc("myc_review_labels", {"p_room": "main"}) or [] if x["item_type"] == "category"]
        need = taxo.corr_needs(labels)
        vers = {r["version"]: self.version(r) for r in pub if r["version"] in need}
        corr = taxo.corrections(labels, vers, self.inp)
        n_corr = len(labels)
        key_base = f"{self.meta['files']['inputs.json'][:12]}|{n_corr}"
        if cur and n_corr > (cur.get("n_corr") or 0):
            params = dict(cur["params"]) or taxo.PARAMS[0]
            if self.inp.seed and not params.get("seed"):  # nowe poprawki, a jest drzewo seed – przejdź na tryb seed
                params = dict(taxo.SEED_PARAMS[0])
        else:
            space = (taxo.SEED_PARAMS if self.inp.seed else []) + taxo.PARAMS  # z drzewem seed najpierw jego ustawienia
            todo = [p for p in space if f"{key_base}|{json.dumps(p, sort_keys=True)}" not in self.state["tried"]]
            if not todo:
                # przestrzeń wyczerpana: mała losowa zmiana najlepszych ustawień (prawdziwe przeszukiwanie)
                base = dict(cur["params"]) if cur else taxo.PARAMS[0]
                rnd = random.Random(time.time_ns())
                params = {
                    "beta": round(max(0.0, base.get("beta", 2) + rnd.choice([-1, -0.5, 0.5, 1])), 2),
                    "k1": max(6, min(30, base.get("k1", 12) + rnd.choice([-4, -2, 2, 4]))),
                    "min": max(10, min(60, base.get("min", 30) + rnd.choice([-5, 5]))),
                    "frag": max(6, min(24, base.get("frag", 14) + rnd.choice([-2, 2]))),
                    **({"seed": 1} if base.get("seed") and self.inp.seed else {}),
                }
            else:
                params = todo[0]
        t0 = time.perf_counter()
        res, m = taxo.build(self.inp, params, corr)
        ms = int((time.perf_counter() - t0) * 1000)
        self.stats["taxo_built"] += 1
        self.stats["taxo_ms"] += ms
        self.state["tried"] = (self.state["tried"] + [f"{key_base}|{json.dumps(params, sort_keys=True)}"])[-300:]
        self._save()
        better = cur is None or m["acc"] > cur["acc"] or (n_corr > (cur.get("n_corr") or 0) and m["acc"] >= cur["acc"])
        self.log(
            f"taksonomia: {params} → trafność {m['acc']:.4f}, NMI {m['nmi_cat']:.3f}, {m['n_nodes']} grup ({ms} ms); opublikowana: {cur['acc'] if cur else '–'}"
        )
        if not better:
            return {"kind": "build", "acc": m["acc"], "params": params, "proposed": False}
        v = (cur["version"] + 1) if cur else 0
        body = taxo.result_bytes(
            res,
            {
                "version": v,
                "params": params,
                "metrics": m,
                "inputs_sha": self.meta["files"]["inputs.json"],
                "n_corr": n_corr,
            },
        )
        path = f"taxo/v{v}-{hashlib.sha256(body).hexdigest()[:8]}.json"
        self.sb.upload(path, body)
        r = self.sb.rpc(
            "myc_tax_propose",
            {
                "p_node": self.node.id,
                "p_path": path,
                "p_acc": m["acc"],
                "p_nmi": m["nmi_cat"],
                "p_purity": m["purity_cat"],
                "p_metrics": m,
                "p_params": params,
                "p_eval_n": self.meta["eval_n"],
                "p_eval_sha": self.meta["eval_sha"],
                "p_inputs_sha": self.meta["files"]["inputs.json"],
                "p_n_corr": n_corr,
                "p_ms": ms,
            },
        )
        self.stats["taxo_proposed"] += 1
        self.log(f"taksonomia: kandydat v{v} → {r}")
        return {"kind": "propose", "version": v, "acc": m["acc"], "res": r}

    def frags(self, row: dict) -> None:
        """Opublikowana wersja → strzępki: temat (warstwa 2) obejmuje kategorie (warstwa 1), kategoria zawiera słowa."""
        if row["version"] in self.state["frags"]:
            return
        res = self.version(row)
        nodes, words = res["nodes"], self.inp.words
        fr, links = [], []
        ref = f"taxo:v{row['version']}"
        for nd in nodes:
            if nd["lvl"] != 1 or nd.get("src") in ("auto", "medoid"):  # grupy bez nazwy tylko wewnętrznie
                continue
            top = nodes[nd["p"]] if nd["p"] >= 0 else None
            hint = 0.35 + 0.35 * min(1.0, nd.get("cov", 0) * 1.5)
            for i in nd["top"][:5]:
                w, lang = words[i]
                f = {
                    "layer": 1,
                    "subj": nd["name_pl"][:160],
                    "rel": "zawiera",
                    "obj": w,
                    "lang": "pl",
                    "source": "taxonomy",
                    "ref": ref,
                    "hint": hint,
                }
                fr.append(f)
                if top:
                    t = {
                        "layer": 2,
                        "subj": top["name_pl"][:160],
                        "rel": "obejmuje",
                        "obj": nd["name_pl"][:300],
                        "lang": "pl",
                        "source": "taxonomy",
                        "ref": ref,
                        "hint": hint,
                    }
                    if t not in fr:
                        fr.append(t)
                    links.append({"src": f, "dst": t, "kind": "part_of", "w": round(hint, 3)})
        for i in range(0, len(fr), 200):
            chunk = fr[i : i + 200]
            ln = [x for x in links if x["src"] in chunk and x["dst"] in chunk][:400]
            self.sb.rpc("myc_frag_add", {"p_node": self.node.id, "p_frags": chunk, "p_links": ln})
        self.state["frags"] = (self.state["frags"] + [row["version"]])[-50:]
        self._save()
        self.log(f"taksonomia: v{row['version']} → {len(fr)} strzępków (pojęcia i tematy)")

    def step(self) -> dict | None:
        self.load()
        rows = self.sb.rpc("myc_tax_list", {"p_limit": 60}) or []
        pend = [r for r in rows if r["status"] == "pending"]
        out = None
        if pend and pend[0]["proposer"] != self.node.id:
            out = self.verify(pend[0])
        elif not pend:
            out = self.propose(rows)
        pub = [r for r in rows if r["status"] == "published"]
        if pub:
            with contextlib.suppress(Exception):
                self.frags(max(pub, key=lambda r: r["version"]))
        return out

    async def run(self, stop: asyncio.Event):
        await asyncio.sleep(random.uniform(20, 90))
        while not stop.is_set():
            sched = getattr(self.node, "sched", None)  # przydział mocy z lokalnego panelu (sched.py)
            if sched is not None and not sched.allowed("taxo"):
                sched.waits += 1
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(stop.wait(), 60)
                continue
            try:
                # grupowanie trwa ok. 2 s CPU – bez blokady czatu (pobieranie danych nie może wstrzymać odpowiedzi)
                with sched.job("taxo") if sched is not None else contextlib.nullcontext():
                    r = await asyncio.to_thread(self.step)
                if r:
                    self.last_job = {**r, "at": time.time()}
            except Exception as e:  # noqa: BLE001 – praca w tle nie może zatrzymać węzła
                self.log(f"taksonomia: błąd {e}")
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), PERIOD * random.uniform(0.8, 1.2))
