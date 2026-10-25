"""Praca węzła dla rozbioru zdań (warstwa rozumienia): uczenie federacyjne (FedAvg) i niezależna weryfikacja.

Cykl co ok. 20 min (CPU dzielony z czatem; przydział mocy z panelu: rodzaj „rozumienie”):
1. cudzy kandydat (inny węzeł, inne IP) → przelicz role-F1 na teście UD → myc_rb_verify,
2. brak mojej aktualizacji od bieżącej wersji → 1 epoka na odłamku train (wybór z id węzła i wersji) → myc_rb_update,
3. ≥ 2 aktualizacje (albo 1 starsza niż 45 min) → średnia ważona liczbą tokenów → ocena → myc_rb_propose
   (baza przyjmuje tylko role-F1 wyższe od opublikowanego; publikacja dopiero po niezależnym przeliczeniu).
Test UD nigdy nie jest używany do treningu (tylko pliki train-*).
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
from datetime import UTC, datetime

import numpy as np

from ..rozbior import model, zbior
from .lmwork import Supa, _http
from .qwen import cache_dir

DATA_URL = os.environ.get("MYC_ROZBIOR_DATA", "https://maciejsearch-cloud.github.io/demo/mycelium/data/rozbior/")
PARITY_URL = os.environ.get(
    "MYC_ROZBIOR_PARITY", "https://maciejsearch-cloud.github.io/demo/mycelium/data/rozbior/parity.json"
)
PERIOD = float(os.environ.get("MYC_ROZBIOR_PERIOD", "1200"))
LOCAL_LR = 3e-4
TRAIN_PREFIX = "train-pdb-"  # licencja wag: UD Polish-PDB (bez LFG – rozdzielenie licencji 25.10.2026)
WAIT_SOLO = 45 * 60  # jedna aktualizacja wystarczy po 45 min (mało węzłów)


class RozbiorWorker:
    def __init__(self, node, log=print):
        self.node, self.log = node, log
        self.sb = Supa()
        self.dir = cache_dir() / "rozbior"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.meta: dict | None = None
        self.test: list | None = None
        self.gate: str | None = None
        self.stats = {"rb_trained": 0, "rb_verified": 0, "rb_proposed": 0, "rb_tokens": 0, "rb_ms": 0}
        self.last_job: dict | None = None

    # ---------------------------------------------------------------- dane
    def _fetch(self, name: str) -> bytes:
        if not DATA_URL.startswith("http"):
            from pathlib import Path

            return (Path(DATA_URL) / name).read_bytes()
        return _http("GET", DATA_URL.rstrip("/") + "/" + name, timeout=300)

    def file(self, name: str) -> bytes:
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$", name) or ".." in name:
            raise ValueError(f"niedozwolona nazwa pliku: {name!r}")
        sha = self.meta["files"][name]
        p = self.dir / name
        b = p.read_bytes() if p.exists() else b""
        if hashlib.sha256(b).hexdigest() != sha:
            b = self._fetch(name)
            if hashlib.sha256(b).hexdigest() != sha:
                raise ValueError(f"suma SHA-256 nie zgadza się: {name}")
            p.write_bytes(b)
        return b

    def load(self) -> None:
        meta = json.loads(self._fetch("meta.json"))
        if self.meta == meta and self.test is not None:
            return
        self.meta = meta
        self.test = zbior.read_files({n: self.file(n) for n in meta["eval_files"]}, "test-")
        self.gate = zbior.gate_sha(meta, self._fetch("parity.json"))

    def weights(self, path: str):
        p = self.dir / path.replace("/", "_")
        b = p.read_bytes() if p.exists() else b""
        if not b:
            b = self.sb.public(path)
            p.write_bytes(b)
        return model.load(b)

    def score(self, H, W) -> dict:
        return zbior.evaluate(H, W, self.test)

    # ---------------------------------------------------------------- kroki
    def verify(self, c: dict) -> dict:
        H, W = self.weights(c["path"])
        t0 = time.perf_counter()
        m = self.score(H, W)
        r = self.sb.rpc("myc_rb_verify", {"p_node": self.node.id, "p_id": c["id"], "p_f1": m["role_f1"]})
        self.stats["rb_verified"] += 1
        self.log(
            f"rozbiór: przeliczyłem kandydata v{c['version']} – role-F1 {m['role_f1']:.4f} (zgłoszone {c['f1']:.4f}) → {r}"
        )
        return {
            "kind": "verify",
            "version": c["version"],
            "f1": m["role_f1"],
            "ms": int((time.perf_counter() - t0) * 1000),
            "res": r,
        }

    def train_update(self, cur: dict) -> dict | None:
        from ..rozbior import trening

        # Linia wersji w bazie = wariant PDB (CC BY-NC-SA 4.0): douczamy tylko na PDB, żeby nie mieszać licencji z LFG (GPL)
        shards = sorted(n for n in self.meta["files"] if n.startswith(TRAIN_PREFIX))
        k = int(hashlib.sha256(f"{self.node.id}|{cur['version']}".encode()).hexdigest(), 16) % len(shards)
        name = shards[k]
        sents = zbior.read_files({name: self.file(name)}, "train-")
        H, W = self.weights(cur["path"])
        net = trening.Net(H)
        net.load_np(W)
        t0 = time.perf_counter()
        steps, toks, loss = trening.train_epochs(net, sents, 1, LOCAL_LR, seed=cur["version"], log=lambda *_: None)
        ms = int((time.perf_counter() - t0) * 1000)
        net.eval()
        body = model.save("", H, net.export())
        path = f"rozbior/u{cur['version']}-{hashlib.sha256(body).hexdigest()[:16]}.bin"
        self.sb.upload(path, body)
        r = self.sb.rpc(
            "myc_rb_update",
            {"p_node": self.node.id, "p_parent": cur["version"], "p_path": path, "p_shard": name.split(".")[0],
             "p_n_sent": len(sents), "p_n_tok": toks, "p_loss": round(loss, 4), "p_ms": ms},
        )  # fmt: skip
        self.stats["rb_trained"] += 1
        self.stats["rb_tokens"] += toks
        self.stats["rb_ms"] += ms
        self.log(
            f"rozbiór: 1 epoka na {name} ({len(sents)} zdań, {toks} tokenów, strata {loss:.3f}, {ms / 1000:.0f} s) → {r}"
        )
        return {
            "kind": "train",
            "version": cur["version"],
            "shard": name,
            "tokens": toks,
            "loss": loss,
            "ms": ms,
            "res": r,
        }

    def aggregate(self, cur: dict, ups: list[dict]) -> dict | None:
        H = None
        acc: dict[str, np.ndarray] = {}
        tot = 0
        for u in ups:
            Hu, Wu = self.weights(u["path"])
            if H is None:
                H = Hu
            elif Hu.get("words") != H.get("words") or Hu.get("deprels") != H.get("deprels"):
                continue
            w = float(u["n_tok"])
            tot += w
            for k, v in Wu.items():
                if not np.isfinite(v).all():
                    raise ValueError(f"nieskończone wartości w aktualizacji {u['id']}")
                acc[k] = acc.get(k, 0) + v * w
        W = {k: v / tot for k, v in acc.items()}
        Hc, _ = self.weights(cur["path"])
        Hc = dict(Hc)
        Hc["train"] = {"fedavg": [u["id"] for u in ups], "parent": cur["version"], "tokens": int(tot)}
        body = model.save("", Hc, W)
        H2, W2 = model.load(body)  # oceniamy dokładnie to, co publikujemy (fp16)
        t0 = time.perf_counter()
        m = self.score(H2, W2)
        ms = int((time.perf_counter() - t0) * 1000)
        v = cur["version"] + 1
        path = f"rozbior/v{v}-{hashlib.sha256(body).hexdigest()[:8]}.bin"
        self.log(f"rozbiór: FedAvg {len(ups)} aktualizacji → role-F1 {m['role_f1']:.4f} (opublikowane {cur['f1']:.4f})")
        if m["role_f1"] <= cur["f1"]:
            # bez wysyłania pliku – baza i tak odrzuci; zgłoszenie odrzucenia zużywa aktualizacje (nowa runda)
            path = f"rozbior/v{v}-00000000.bin"
        else:
            self.sb.upload(path, body)
        r = self.propose(path, cur["version"], m, [u["id"] for u in ups], ms)
        return {"kind": "propose", "version": v, "f1": m["role_f1"], "ms": ms, "res": r}

    def propose(self, path: str, parent, m: dict, ups: list[int], ms: int) -> dict:
        r = self.sb.rpc(
            "myc_rb_propose",
            {"p_node": self.node.id, "p_path": path, "p_parent": parent, "p_f1": m["role_f1"], "p_upos": m["upos"],
             "p_feats": m["feats"], "p_las": m["las"], "p_metrics": slim(m), "p_eval_n": len(self.test),
             "p_eval_sha": self.gate, "p_updates": ups, "p_ms": ms},
        )  # fmt: skip
        self.stats["rb_proposed"] += 1
        self.log(f"rozbiór: kandydat → {r}")
        return r

    def step(self) -> dict | None:
        self.load()
        rows = self.sb.rpc("myc_rb_list", {"p_limit": 30}) or []
        pend = [r for r in rows if r["status"] == "pending"]
        if pend:
            return self.verify(pend[0]) if pend[0]["proposer"] != self.node.id else None
        pub = [r for r in rows if r["status"] == "published"]
        if not pub:
            return None
        cur = max(pub, key=lambda r: r["version"])
        ups = [
            u for u in self.sb.rpc("myc_rb_updates_list", {"p_parent": cur["version"]}) or [] if u["used_in"] is None
        ]
        if not any(u["node"] == self.node.id for u in ups):
            return self.train_update(cur)
        oldest = min(datetime.fromisoformat(u["created_at"]).timestamp() for u in ups)
        if len(ups) >= 2 or time.time() - oldest > WAIT_SOLO:
            return self.aggregate(cur, ups[:16])
        return None

    async def run(self, stop: asyncio.Event):
        await asyncio.sleep(random.uniform(30, 120))
        while not stop.is_set():
            sched = getattr(self.node, "sched", None)
            if sched is not None and not sched.allowed("rozbior"):
                sched.waits += 1
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(stop.wait(), 60)
                continue
            try:
                with sched.job("rozbior") if sched is not None else contextlib.nullcontext():
                    r = await asyncio.to_thread(self.step)
                if r:
                    self.last_job = {**r, "at": time.time()}
            except Exception as e:  # noqa: BLE001 – praca w tle nie może zatrzymać węzła
                self.log(f"rozbiór: błąd {e}")
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), PERIOD * random.uniform(0.8, 1.2))


def slim(m: dict) -> dict:
    """Metryki do bazy (< 6 kB): bez list per pytanie poza 12 najczęstszymi."""
    out = {k: v for k, v in m.items() if k not in ("per_q",)}
    out["per_q"] = dict(list(m.get("per_q", {}).items())[:12])
    out["at"] = datetime.now(UTC).isoformat(timespec="seconds")
    return out
