"""Praca węzła dla modelu językowego grzybni: trening adaptera, agregacja, niezależna ocena, czat z najnowszą wersją.

Wszystko przez te same funkcje bazy co pozostałe modele (myc_claim / myc_submit / myc_post_round / myc_reserve /
myc_propose), klucz publikowalny + RLS. Dane: odłamki z web/public/data/lm (strona demo), sprawdzane SHA-256 z meta.json.
CPU jest dzielony z czatem: każdy krok treningu i każdy wsad oceny bierze tę samą blokadę co odpowiedź w czacie.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import gzip
import json
import math
import os
import random
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import lm
from .net import SB_KEY, SB_URL
from .qwen import cache_dir

DATA_URL = os.environ.get("MYC_LM_DATA", "https://maciejsearch-cloud.github.io/demo/mycelium/data/lm/")
# logity nauczyciela (destylacja): pliki danych w wydaniu repozytorium demo, sumy SHA-256 w kd.json
KD_URL = os.environ.get("MYC_LM_KD", "https://github.com/maciejsearch-cloud/demo/releases/download/lm-kd-1/")
# rodzaj zadania z kolejki → rodzaj w przydziale mocy (sched.py)
SCHED_KIND = {"train": "lm_train", "reeval": "lm_eval"}
ROUND_JOBS = int(os.environ.get("MYC_LM_ROUND_JOBS", "12"))
# udział zadań z destylacją w rundzie (reszta: czysta entropia krzyżowa na Wikipedii) i liczba zadań na odłamkach
# „rozwiązane poprawnie zadania logiczne” (meta.json → sft); oba ustawienia jawne w params zadania
KD_FRAC = float(os.environ.get("MYC_LM_KD_FRAC", "0.5"))
# 31.10: 2 = w każdej rundzie oba odłamki sft (logika + matematyka), zamiast losowo jednego
SFT_JOBS = int(os.environ.get("MYC_LM_SFT_JOBS", "2"))
STEPS, BATCH, LR = 16, 8, 1e-3
SERVER_LRS = (1.0, 0.5)
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")  # nazwy plików z meta.json: bez ścieżek (../)
ADAPTER_PATH = re.compile(r"^lm/v[0-9]{1,6}-[0-9a-f]{8}\.bin$")
UA = "MyceliumNode/2 (+https://maciejsearch-cloud.github.io/demo/mycelium/)"


def _http(method: str, url: str, body: bytes | None = None, headers: dict | None = None, timeout=120) -> bytes:
    h = {"User-Agent": UA, **(headers or {})}
    last = None
    for attempt in range(5):
        req = urllib.request.Request(url, data=body, headers=h, method=method)  # noqa: S310 – stałe adresy https
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429:
                raise RuntimeError(f"HTTP {e.code} {url.split('?')[0]}: {e.read()[:300]!r}") from None
            # 5xx: zachowaj treść (SQLSTATE PostgREST), żeby log mówił, co padło – nie tylko „500”
            last = f"HTTP {e.code} {url.split('?')[0].rsplit('/', 1)[-1]}: {e.read()[:300]!r}"
        except OSError as e:
            last = e
        time.sleep(2 + 3 * attempt)
    raise RuntimeError(f"sieć: {last}")


def _finite(v):
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_finite(x) for x in v]
    return v


class Supa:
    H = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

    def get(self, path: str):
        return json.loads(_http("GET", f"{SB_URL}/rest/v1/{path}", headers=self.H))

    def rpc(self, fn: str, args: dict):
        b = json.dumps(_finite(args)).encode()  # NaN/inf → null (inaczej PostgREST: „Empty or invalid json”)
        r = _http("POST", f"{SB_URL}/rest/v1/rpc/{fn}", b, {**self.H, "Content-Type": "application/json"})
        return json.loads(r) if r else None

    def upload(self, path: str, data: bytes):
        _http(
            "POST",
            f"{SB_URL}/storage/v1/object/myc-models/{path}",
            data,
            {**self.H, "Content-Type": "application/octet-stream"},
        )

    def public(self, path: str) -> bytes:
        return _http("GET", f"{SB_URL}/storage/v1/object/public/myc-models/{path}")


class Data:
    """Odłamki i zbiór testowy z pamięcią podręczną na dysku; każdy plik sprawdzany sumą SHA-256 z meta.json."""

    def __init__(self, base: str = DATA_URL, meta_name: str = "meta.json"):
        self.base, self.meta_name = base, meta_name
        self.dir = cache_dir() / "lm"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._meta: dict | None = None
        self._meta_at = 0.0

    def _fetch(self, name: str) -> bytes:
        if not self.base.startswith("http"):
            return (Path(self.base) / name).read_bytes()
        return _http("GET", self.base.rstrip("/") + "/" + name, timeout=300)

    def meta(self) -> dict:
        if self._meta is None or time.time() - self._meta_at > 3600:
            self._meta = json.loads(self._fetch(self.meta_name))
            self._meta_at = time.time()
        return self._meta

    def file(self, name: str, sha: str) -> bytes:
        if not isinstance(name, str) or not SAFE_NAME.match(name) or ".." in name:
            raise ValueError(f"niedozwolona nazwa pliku: {name!r}")
        p = self.dir / name
        if p.exists():
            b = p.read_bytes()
            if lm.sha256(b) == sha:
                return b
        b = self._fetch(name)
        if lm.sha256(b) != sha:
            raise ValueError(f"suma SHA-256 nie zgadza się: {name}")
        p.write_bytes(b)
        return b

    def shard(self, i: int):
        f = self.meta()["files"][i]
        _, ids, mask, _ = lm.unpack_data(gzip.decompress(self.file(f["name"], f["sha256"])))
        return ids, mask

    def sft(self, spec: dict):
        """Odłamek „sft” z meta.json (nazwa i SHA-256 z zadania muszą być na liście – nie pobieramy niczego spoza niej)."""
        known = {(f["name"], f["sha256"]) for f in self.meta().get("sft", [])}
        if (spec.get("name"), spec.get("sha256")) not in known:
            raise ValueError("nieznany odłamek sft")
        _, ids, mask, _ = lm.unpack_data(gzip.decompress(self.file(spec["name"], spec["sha256"])))
        return ids, mask

    def eval_bytes(self) -> bytes:
        e = self.meta()["eval"]
        return self.file(e["name"], e["sha256"])

    @property
    def n_shards(self) -> int:
        return int(self.meta()["shards"])


class LMWorker:
    def __init__(self, node, train: bool = True, log=print, micro: int | None = None):
        self.micro = micro
        self._gm = None  # (model na GPU, urządzenie) – tylko gdy włączone w panelu i test GPU przeszedł
        self.backend = "cpu"  # gdzie policzono ostatni krok treningu (zapisywane uczciwie w myc_results.backend)
        self.gpu_note = ""
        self.node, self.m, self.log = node, node.m, log
        self.kd = Data(KD_URL, "kd.json")
        self.train_on = train
        self.sb = Supa()
        self.data = Data()
        self.adapters: dict[str, lm.Lora] = {}
        self.stats = {"lm_train": 0, "lm_eval": 0, "lm_tokens": 0, "lm_flops": 0.0, "lm_rounds": 0, "lm_proposed": 0}
        self.stats["lm_version"] = None
        self.last_job: dict | None = None

    # ---------------------------------------------------------------- wspólne
    async def _locked(self, fn, *a):
        async with self.node.lock:
            return await asyncio.to_thread(fn, *a)

    async def _eval(self, lora: lm.Lora | None) -> dict:
        eb = await asyncio.to_thread(self.data.eval_bytes)
        it = lm.evaluate_iter(self.m, lora, eb)

        def nxt():
            try:
                next(it)
                return None
            except StopIteration as e:
                return e.value

        while True:
            r = await self._locked(nxt)
            if r is not None:
                return r

    async def adapter(self, path: str) -> lm.Lora:
        if path not in self.adapters:
            if not isinstance(path, str) or not ADAPTER_PATH.match(path):
                raise ValueError("adapter: niedozwolona ścieżka")
            b = await asyncio.to_thread(self.sb.public, path)
            if not path.endswith(f"-{lm.sha256(b)[:8]}.bin"):
                raise ValueError("adapter: suma nie zgadza się ze ścieżką")
            self.adapters[path] = lm.Lora.from_bytes(b)
            while len(self.adapters) > 4:
                del self.adapters[next(iter(self.adapters))]
        return self.adapters[path]

    async def latest(self) -> dict | None:
        rows = await asyncio.to_thread(
            self.sb.get, "myc_models?model=eq.lm&order=version.desc&limit=1&select=version,path,acc,meta"
        )
        return rows[0] if rows else None

    async def sync_chat(self):
        """Czat grzybni korzysta z najnowszej opublikowanej (zweryfikowanej) wersji adaptera."""
        cur = await self.latest()
        if not cur or cur["version"] == self.m.lora_version:
            return
        a = await self.adapter(cur["path"])
        async with self.node.lock:
            self.m.lora = lm.runtime(a, self.m.dtype)
            self.m.lora_version = cur["version"]
            self.m.sessions.clear()
            self.node.kv.clear()
        self.node.net.state["lm"] = cur["version"]
        self.stats["lm_version"] = cur["version"]
        self.log(
            f"czat: model językowy grzybni v{cur['version']} (perpleksja {cur['meta'].get('ppl')}, trafność {cur['acc']})"
        )

    # ---------------------------------------------------------------- zadania
    async def step(self) -> bool:
        """Jedno zadanie z kolejki (trening / ponowna ocena). False = nic do zrobienia."""
        kinds = ["reeval", "train"] if self.train_on else ["reeval"]
        sched = getattr(self.node, "sched", None)  # przydział mocy z lokalnego panelu (sched.py)
        if sched is not None:
            kinds = [k for k in kinds if sched.allowed(SCHED_KIND[k])]
            if not kinds:
                sched.waits += 1
                return False
        jobs = await asyncio.to_thread(
            self.sb.rpc, "myc_claim", {"p_node": self.node.id, "p_models": ["lm"], "p_kinds": kinds}
        )
        if not jobs:
            return False
        job = jobs[0]
        t0 = time.perf_counter()
        kd = isinstance((job.get("params") or {}).get("kd"), dict)
        tok = sched.start(SCHED_KIND.get(job["kind"], "lm_eval")) if sched is not None else None
        try:
            if job["kind"] == "train":
                payload, metrics, samples, flops = await self._train(job)
            else:
                payload, metrics, samples, flops = await self._reeval(job)
        except Exception as e:  # noqa: BLE001 – zadanie wróci do puli po wygaśnięciu dzierżawy
            self.log(f"zadanie {job['id']} ({job['kind']}) nieudane: {type(e).__name__}: {e}")
            return True
        finally:
            if tok is not None:
                sched.end(tok, label="lm_distill" if kd else None)
        ms = int((time.perf_counter() - t0) * 1000)
        rid = await asyncio.to_thread(
            self.sb.rpc,
            "myc_submit",
            {
                "p_job": job["id"],
                "p_node": self.node.id,
                "p_contrib": self.node.id,
                "p_payload": payload,
                "p_metrics": metrics,
                "p_samples": samples,
                "p_flops": flops,
                "p_ms": min(ms, 3_600_000),
                "p_backend": self.backend if job["kind"] == "train" else "cpu",
            },
        )
        self.stats["lm_flops"] += flops
        self.last_job = {
            "kind": job["kind"],
            "id": job["id"],
            "kd": kd,
            "version": job["version"],
            "at": time.time(),
            "ms": ms,
            "result": rid,
            **metrics,
        }
        self.log(
            f"zadanie {job['id']} {job['kind']} v{job['version']}: {ms / 1000:.0f} s, wynik {rid}, {json.dumps(metrics)[:200]}"
        )
        return True

    async def _train(self, job):
        p = job["params"]
        cur = (await asyncio.to_thread(self.sb.get, f"myc_models?model=eq.lm&version=eq.{job['version']}&select=path"))[
            0
        ]
        base = await self.adapter(cur["path"])
        kd, kd_info = None, {}
        if isinstance(p.get("sft"), dict):
            # odłamek z poprawnie rozwiązanymi zadaniami logicznymi (strata tylko na odpowiedzi), bez destylacji
            ids, mask = await asyncio.to_thread(self.data.sft, p["sft"])
            kd_info = {"sft": p["sft"]["name"]}
        else:
            ids, mask = await asyncio.to_thread(self.data.shard, int(p["shard"]))
        if isinstance(p.get("kd"), dict) and "sft" not in kd_info:
            kd = await asyncio.to_thread(self._kd, p["kd"], int(p["shard"]))
            kd_info = {"kd": p["kd"]["name"], "kd_T": kd[2], "kd_alpha": kd[3]}

        def trainer(model, dev):
            return lm.Trainer(
                model,
                base,
                ids,
                mask,
                int(p.get("batch", BATCH)),
                float(p.get("lr", LR)),
                int(p.get("seed", 0)),
                micro=self.micro,
                kd=kd,
                device=dev,
            )

        out = st = None
        gm = await asyncio.to_thread(self._gpu_model)
        if gm is not None:
            try:
                tr = trainer(*gm)
                for _ in range(int(p.get("steps", STEPS))):
                    await self._locked(tr.step)
                out, st = tr.result()
                if not all(math.isfinite(x) for x in tr.losses) or tr.losses[0] > 12:
                    raise ValueError(f"strata na GPU poza zakresem ({tr.losses[0]:.3f})")
                self.backend = "directml"
            except Exception as e:  # noqa: BLE001 – GPU zawiodło: ten sam krok na CPU, GPU wyłączone do nowego testu
                self.gpu_note = f"GPU wyłączone po błędzie: {type(e).__name__}: {str(e)[:160]}"
                self.log(self.gpu_note)
                self._disable_gpu()
                out = None
        if out is None:
            tr = trainer(self.m, None)
            for _ in range(int(p.get("steps", STEPS))):
                await self._locked(tr.step)
            out, st = tr.result()
            self.backend = "cpu"
        if not out.finite() or tr.skipped > int(p.get("steps", STEPS)) // 2:
            # nie zgłaszamy: zadanie wraca do puli po wygaśnięciu dzierżawy, nic nie trafia do FedAvg ani statystyk
            raise ValueError(f"trening niestabilny (pominięte kroki {tr.skipped}, adapter skończony: {out.finite()})")
        if tr.skipped:
            self.log(
                f"trening: pominięto {tr.skipped} krok(ów) z nieskończoną stratą/gradientem (odłamek {p['shard']})"
            )
        b = out.to_bytes({"base": job["version"], "shard": p["shard"]})
        self.stats["lm_train"] += 1
        self.stats["lm_tokens"] += st["tokens"]
        flops = st["tokens"] * lm.FLOPS_TRAIN_TOKEN
        return base64.b64encode(b).decode(), {**st, "shard": p["shard"], **kd_info}, st["tokens"], flops

    def _gpu_model(self):
        """Model na DirectML, gdy panel włączył GPU i test na tym komputerze przeszedł (szybsze + ta sama strata)."""
        sched = getattr(self.node, "sched", None)
        if sched is None or not sched.alloc.get("gpu_on"):
            self._gm = None
            return None
        from . import gpu

        b = gpu.load_bench()
        if not (b and b.get("ok")) or not gpu.dml_available():
            return None
        if self._gm is None:
            import torch

            dev = gpu.dml_device()
            self._gm = (gpu.DevModel(self.m, dev, getattr(torch, b["dtype"])), dev)
            self.log(f"trening na GPU (DirectML, {b['dtype']}, {b.get('adapter')})")
        return self._gm

    def _disable_gpu(self):
        from . import gpu

        self._gm = None
        b = gpu.load_bench() or {"v": gpu.BENCH_VERSION}
        b.update({"ok": False, "reason": self.gpu_note})
        gpu._save(b)

    def _kd(self, spec: dict, shard: int):
        """Logity nauczyciela dla odłamka: plik z wydania (suma SHA-256 z zadania), zgodność z odłamkiem sprawdzana."""
        b = gzip.decompress(self.kd.file(spec["name"], spec["sha256"]))
        meta, idx, lg = lm.unpack_kd(b)
        f = self.data.meta()["files"][shard]
        if int(meta.get("shard", -1)) != shard or meta.get("train_sha256") != f["sha256"]:
            raise ValueError("plik destylacji dla innego odłamka")
        T = min(8.0, max(1.0, float(spec.get("T", lm.KD_T))))
        a = min(1.0, max(0.0, float(spec.get("alpha", lm.KD_ALPHA))))
        return idx, lg, T, a

    def kd_files(self) -> dict[int, dict]:
        """Odłamki z gotowymi logitami nauczyciela (pusto, gdy wydania jeszcze nie ma)."""
        try:
            km = self.kd.meta()
        except Exception:  # noqa: BLE001 – brak pliku = trening bez destylacji
            return {}
        self._teacher = km.get("teacher")
        return {int(f["shard"]): f for f in km.get("files", []) if SAFE_NAME.match(str(f.get("name", "")))}

    async def _reeval(self, job):
        a = await self.adapter(job["params"]["path"])
        r = await self._eval(a.roundtrip())
        self.stats["lm_eval"] += 1
        metrics = {
            "acc": r["acc"],
            "n": r["n"],
            "eval_sha": r["eval_sha"],
            "ppl": r["ppl"],
            "candidate": job["params"]["candidate"],
        }
        return None, metrics, r["positions"], r["positions"] * lm.FLOPS_EVAL_TOKEN

    # ---------------------------------------------------------------- koordynacja (dowolny węzeł)
    async def coordinate(self):
        cur = await self.latest()
        pend = await asyncio.to_thread(self.sb.get, "myc_candidates?model=eq.lm&status=eq.pending&select=id")
        if pend:
            return
        if cur is None:
            await self._propose(None, lm.Lora.init(), [], [], 1.0)
            return
        v = cur["version"]
        open_ = await asyncio.to_thread(
            self.sb.get,
            f"myc_jobs?model=eq.lm&version=eq.{v}&kind=eq.train&status=in.(open,leased)&select=id,created_at",
        )
        res = await asyncio.to_thread(
            self.sb.get,
            f"myc_results?model=eq.lm&version=eq.{v}&kind=eq.train&status=eq.pending&select=id,created_at&order=id",
        )
        if not open_ and not res:
            n = self.data.n_shards - 1  # ostatni odłamek = walidacja agregatora (nie do treningu)
            kdf = {s: f for s, f in (await asyncio.to_thread(self.kd_files)).items() if s < n}
            sft = [
                f
                for f in (await asyncio.to_thread(self.data.meta)).get("sft", [])
                if SAFE_NAME.match(str(f.get("name", "")))
            ]
            n_sft = min(SFT_JOBS, len(sft), ROUND_JOBS)
            n_kd = min(round(KD_FRAC * (ROUND_JOBS - n_sft)), len(kdf))
            # część odłamków z logitami nauczyciela (destylacja), reszta losowo bez destylacji
            shards = random.sample(sorted(kdf), n_kd)
            # reszta bez destylacji: najpierw odłamki bez logitów nauczyciela; gdy logity ma (prawie) każdy odłamek
            # (od 31.10 wszystkie 399), dobieramy pozostałe odłamki i trenujemy je bez destylacji
            need = ROUND_JOBS - n_sft - len(shards)
            plain = sorted(set(range(n)) - set(kdf))
            extra = random.sample(plain, min(need, len(plain)))
            extra += random.sample(sorted(set(range(n)) - set(shards) - set(extra)), need - len(extra))
            kd_on = set(shards)
            shards += extra
            jobs = []
            for f in random.sample(sft, n_sft):
                # starszy węzeł nie zna „sft” i trenuje zwykły odłamek – w metrics zostaje, co naprawdę liczył
                jobs.append(
                    {
                        "kind": "train",
                        "params": {
                            "shard": random.randrange(n),
                            "sft": {"name": f["name"], "sha256": f["sha256"]},
                            "steps": STEPS,
                            "batch": BATCH,
                            "lr": LR,
                            "seed": random.randrange(1 << 30),
                            "flops_per_sample": lm.FLOPS_TRAIN_TOKEN,
                        },
                    }
                )
            for s in shards:
                params = {
                    "shard": s,
                    "steps": STEPS,
                    "batch": BATCH,
                    "lr": LR,
                    "seed": random.randrange(1 << 30),
                    "flops_per_sample": lm.FLOPS_TRAIN_TOKEN,
                }
                if s in kd_on:
                    params["kd"] = {
                        "name": kdf[s]["name"],
                        "sha256": kdf[s]["sha256"],
                        "T": lm.KD_T,
                        "alpha": lm.KD_ALPHA,
                    }
                jobs.append({"kind": "train", "params": params})
            k = await asyncio.to_thread(
                self.sb.rpc, "myc_post_round", {"p_node": self.node.id, "p_model": "lm", "p_version": v, "p_jobs": jobs}
            )
            if k and k > 0:
                self.stats["lm_rounds"] += 1
                self.log(f"runda modelu językowego v{v}: {k} zadań treningu")
            return
        if len(res) >= 3 and not open_:
            await self._aggregate(cur)

    async def _aggregate(self, cur: dict):
        v = cur["version"]
        self._kd_used = self._sft_used = False
        es = (await asyncio.to_thread(self.data.meta))["eval"]
        if (cur.get("meta") or {}).get("eval_sha") != es["sha256"]:
            # nowy zbiór testowy: bramka czeka na przeliczenie bieżącej wersji przez niezależnego weryfikatora
            self.log(f"model językowy: v{v} czeka na ocenę bazową na nowym zbiorze testowym ({es['sha256'][:12]})")
            return
        r = await asyncio.to_thread(
            self.sb.rpc, "myc_reserve", {"p_node": self.node.id, "p_model": "lm", "p_expected": v}
        )
        if not r or not r.get("ok"):
            return
        meta = await asyncio.to_thread(
            self.sb.get,
            f"myc_results?model=eq.lm&version=eq.{v}&kind=eq.train&status=eq.pending&select=id,samples,node_id,metrics&order=id",
        )
        # ładunki LoRA (~1 MB base64 każdy) stronami po 4 – jedno zapytanie o całą rundę (~100 MB) przeciążało bazę 25.10
        rows = []
        for i in range(0, len(meta), 4):
            part = meta[i : i + 4]
            got = await asyncio.to_thread(
                self.sb.get, f"myc_results?id=in.({','.join(str(r['id']) for r in part)})&select=id,payload"
            )
            pay = {g["id"]: g["payload"] for g in got}
            rows += [{**r, "payload": pay.get(r["id"])} for r in part if pay.get(r["id"])]
        base = await self.adapter(cur["path"])
        vids, vmask = await asyncio.to_thread(self.data.shard, self.data.n_shards - 1)
        vids, vmask = vids[:16], vmask[:16]
        base_val = await self._locked(lm.mean_nll, self.m, base, vids, vmask)
        ok, bad = [], []
        for row in rows:
            try:
                u = lm.Lora.from_bytes(base64.b64decode(row["payload"]))
                if not u.finite():
                    raise ValueError("adapter zawiera NaN/inf")
                val = await self._locked(lm.mean_nll, self.m, u, vids, vmask)
                if not math.isfinite(val):
                    raise ValueError("walidacja NaN/inf")
            except Exception as e:  # noqa: BLE001 – uszkodzona aktualizacja = odrzucona
                self.log(f"aktualizacja {row['id']} odrzucona: {e}")
                bad.append(row["id"])
                continue
            ok.append((row["id"], u, row["samples"], val))
            if (row.get("metrics") or {}).get("kd"):
                self._kd_used = True
            if (row.get("metrics") or {}).get("sft"):
                self._sft_used = True
        # aktualizacja wyraźnie psująca walidację (> 2%) jest odrzucana; gdy dobrych jest < 3, decyduje bramka
        good = [x for x in ok if x[3] <= base_val * 1.02]
        if len(good) >= 3:
            bad += [x[0] for x in ok if x[3] > base_val * 1.02]
            ok = good
        if len(ok) < 3:
            self.log(f"za mało aktualizacji ({len(ok)}); runda czeka")
            return
        avg = lm.Lora.average([(u, w) for _, u, w, _ in ok])
        cur_ppl = cur["meta"].get("ppl")
        cur_correct = cur["meta"].get("correct")
        best = None
        for s in SERVER_LRS:
            cand = lm.Lora(*[b + s * (a - b) for a, b in zip(avg.tensors(), base.tensors(), strict=True)]).roundtrip()
            e = await self._eval(cand)
            self.log(
                f"kandydat v{v + 1} (krok {s}): perpleksja {e['ppl']} (było {cur_ppl}), trafność {e['acc']} (było {cur['acc']})"
            )
            passed = (cur_ppl is None or e["ppl"] <= cur_ppl) and (cur_correct is None or e["correct"] >= cur_correct)
            if best is None or passed:
                best = (cand, e, s)
            if passed:
                break
        cand, e, s = best
        await self._propose(cur, cand, [x[0] for x in ok], bad, s, e, base_val, [x[3] for x in ok])

    async def _propose(self, cur, cand: lm.Lora, accepted, rejected, server_lr, e=None, base_val=None, vals=None):
        v = -1 if cur is None else cur["version"]
        if cur is None:
            r = await asyncio.to_thread(
                self.sb.rpc, "myc_reserve", {"p_node": self.node.id, "p_model": "lm", "p_expected": -1}
            )
            if not r or not r.get("ok"):
                return
            e = await self._eval(cand.roundtrip())
        if cur is not None:
            # ocena kandydatów trwa minuty (2000 pytań) – odnów rezerwację tuż przed zgłoszeniem
            r = await asyncio.to_thread(
                self.sb.rpc, "myc_reserve", {"p_node": self.node.id, "p_model": "lm", "p_expected": v}
            )
            if not r or not r.get("ok"):
                self.log(f"model językowy: rezerwacja v{v + 1} utracona: {r}")
                return
        b = cand.to_bytes({"version": v + 1})
        path = f"lm/v{v + 1}-{lm.sha256(b)[:8]}.bin"
        exists = await asyncio.to_thread(self.sb.rpc, "myc_weights_exist", {"p_path": path})
        if not exists:
            await asyncio.to_thread(self.sb.upload, path, b)
        meta = {
            "ppl": e["ppl"],
            "correct": e["correct"],
            "algo": "init"
            if cur is None
            else ("fedavg-lora-kd" if getattr(self, "_kd_used", False) else "fedavg-lora")
            + ("+sft-logic" if getattr(self, "_sft_used", False) else ""),
            "teacher": (getattr(self, "_teacher", None) if getattr(self, "_kd_used", False) else None),
            "server_lr": server_lr,
            "rank": lm.RANK,
            "params": lm.N_PARAMS,
            "base": "Qwen2.5-0.5B-Instruct",
            "data": "plwiki-20231101 (CC BY-SA 4.0)",
            "flops": lm.FLOPS_EVAL_TOKEN,
            "sha256": lm.sha256(b),
            "val_base": None if base_val is None else round(base_val, 5),
            "val_updates": None if not vals else [round(x, 5) for x in vals],
        }
        r = await asyncio.to_thread(
            self.sb.rpc,
            "myc_propose",
            {
                "p_node": self.node.id,
                "p_model": "lm",
                "p_version": v + 1,
                "p_path": path,
                "p_acc": e["acc"],
                "p_val": None,
                "p_eval_n": e["n"],
                "p_eval_sha": e["eval_sha"],
                "p_meta": meta,
                "p_accepted": accepted,
                "p_rejected": rejected,
            },
        )
        self.stats["lm_proposed"] += 1
        self.log(f"zgłoszono kandydata modelu językowego v{v + 1}: {r}")

    # ---------------------------------------------------------------- pętla
    async def run(self, stop: asyncio.Event):
        await asyncio.sleep(5)
        last_sync = last_coord = 0.0
        while not stop.is_set():
            idle = True
            with contextlib.suppress(Exception):
                if time.time() - last_sync > 120:
                    last_sync = time.time()
                    await self.sync_chat()
            try:
                idle = not await self.step()
                if idle and self.train_on and time.time() - last_coord > 30:
                    last_coord = time.time()
                    await self.coordinate()
            except Exception as e:  # noqa: BLE001 – sieć/baza: spróbuj później
                self.log(f"model językowy: {type(e).__name__}: {e}")
            if idle:
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(stop.wait(), 20)
