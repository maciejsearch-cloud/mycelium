"""Praca węzła przy Puzzle #71: ≈10 % mocy, najniższy priorytet, za zgodą (docs/puzzle71.md).

Ograniczenie mocy: jeden wątek o priorytecie nice 19 (Linux: per wątek), cykl pracy liczony z prawdziwego czasu CPU
wątku: po każdym kawałku (2^20 kluczy) wątek śpi tyle, żeby średnio zużyć `pct`% z `threads` wątków węzła
(np. 10 % z 4 wątków = 0,4 rdzenia). Postęp paczki zapisywany lokalnie (wznowienie po restarcie).

Trafienie: klucz NIGDY nie trafia do logu, czatu ani jawnie do bazy. Węzeł szyfruje go kluczem publicznym właściciela
(seal.py), zapisuje szyfrogram lokalnie (chmod 600) i wysyła wyłącznie szyfrogram (myc_p71_hit). Paczka jest potem
raportowana normalnie, żeby z publicznych danych nie dało się wskazać, gdzie było trafienie.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import threading
import time
from pathlib import Path

from . import CHUNK_BITS, RANGE_LO, TARGET_ADDRESS, TARGET_H160, core, seal

PREFIX = "MYC-P71/v1"
SLICE = 1 << 20
BEAT_EVERY = 300.0


def now_ms() -> int:
    return int(time.time() * 1000)


def chunk_start(idx: int) -> int:
    return RANGE_LO + idx * (1 << CHUNK_BITS)


def lower_thread_priority() -> None:
    if sys.platform.startswith("linux"):
        with contextlib.suppress(Exception):
            os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 19)


class P71Worker:
    def __init__(self, node, pct: float, threads: int, log=print, sb=None, key=None, state_dir: Path | None = None):
        from ..qwen import cache_dir

        self.node, self.log = node, log
        self.pct = max(0.0, min(100.0, float(pct)))
        self.threads = max(1, int(threads))
        self.duty = min(1.0, self.pct / 100.0 * self.threads)  # ułamek jednego rdzenia
        self.dir = (state_dir or cache_dir()) / "p71"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.dir / f"state-{node.id[:8]}.json"
        self._sb, self._key = sb, key
        self.target = bytes.fromhex(TARGET_H160)
        assert core.address_h160(TARGET_ADDRESS) == self.target
        self.cc = core.load()
        self.backend = "c" if self.cc else "python"
        self.stats = {"p71_keys": 0, "p71_rate": 0, "p71_chunks": 0, "p71_backend": self.backend, "p71_pct": self.pct}
        self.last_job: dict | None = None
        self.cpu_s = 0.0  # łączny czas CPU wątku (do zakładki Moc)
        self._rate_win: list[tuple[float, int]] = []
        self.stop_ev = threading.Event()

    # -------------------------------------------------------------- sieć
    @property
    def sb(self):
        if self._sb is None:
            from ..lmwork import Supa

            self._sb = Supa()
        return self._sb

    @property
    def key(self):
        if self._key is None:
            from ..walletwork import NodeKey

            self._key = NodeKey(self.node.id)
        return self._key

    def _register(self) -> None:
        msg = "|".join(["MYC-TEST/v1", "nodekey", self.node.id, self.key.pub]).encode()
        with contextlib.suppress(Exception):  # już zarejestrowany (portfel) = OK
            self.sb.rpc(
                "myc_node_key_register", {"p_node": self.node.id, "p_pub": self.key.pub, "p_sig": self.key.sign(msg)}
            )

    def _signed(self, fn: str, parts: list[str], args: dict):
        ts = now_ms()
        sig = self.key.sign("|".join([PREFIX, *parts, str(ts)]).encode())
        return self.sb.rpc(fn, {**args, "p_ts": ts, "p_sig": sig})

    def claim(self) -> dict:
        return self._signed("myc_p71_claim", ["claim", self.node.id], {"p_node": self.node.id})

    def done(self, idx: int, mode: str, xor: str, keys: int, ms: int) -> dict:
        parts = ["done", self.node.id, str(idx), mode, xor, str(keys), str(ms), self.backend]
        args = {"p_node": self.node.id, "p_idx": idx, "p_mode": mode, "p_xor": xor, "p_keys": keys, "p_ms": ms,
                "p_backend": self.backend}  # fmt: skip
        return self._signed("myc_p71_done", parts, args)

    def beat(self) -> None:
        rate, pct = int(self.rate()), int(round(self.pct))
        self._signed("myc_p71_beat", ["beat", self.node.id, str(rate), str(pct), self.backend],
                     {"p_node": self.node.id, "p_rate": rate, "p_pct": pct, "p_backend": self.backend})  # fmt: skip

    # -------------------------------------------------------------- trafienie
    def on_hit(self, k: int, idx: int) -> None:
        """Szyfruje klucz do właściciela; jawny klucz istnieje tylko w pamięci tego wątku."""
        if core.h160_of_key(k) != self.target:  # niezależne sprawdzenie ścieżką Pythona
            self.log("p71: fałszywe trafienie odrzucone (niezgodne z wzorcem)")
            return
        ct = seal.seal({"puzzle": 71, "address": TARGET_ADDRESS, "key_hex": f"{k:064x}", "node": self.node.id,
                        "chunk": idx, "found_ms": now_ms()})  # fmt: skip
        del k
        p = self.dir / f"hit-{now_ms()}.sealed"
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(ct + "\n")
        for _ in range(20):  # do skutku (sieć może chwilowo nie działać); lokalna kopia już jest
            try:
                parts = ["hit", self.node.id, __import__("hashlib").sha256(ct.encode()).hexdigest()]
                self._signed("myc_p71_hit", parts, {"p_node": self.node.id, "p_ct": ct})
                break
            except Exception:  # noqa: BLE001
                time.sleep(30)
        self.log(f"p71: TRAFIENIE – klucz zaszyfrowany do właściciela, kopia lokalna {p.name} (bez jawnego klucza)")

    # -------------------------------------------------------------- skan
    def rate(self) -> float:
        now = time.monotonic()
        self._rate_win = [(t, n) for t, n in self._rate_win if now - t < 600]
        if len(self._rate_win) < 2:
            return 0.0
        dt = self._rate_win[-1][0] - self._rate_win[0][0]
        return sum(n for _, n in self._rate_win[1:]) / dt if dt > 0 else 0.0

    def _scan(self, start: int, n: int) -> tuple[int | None, bytes]:
        return self.cc.scan(start, n, self.target) if self.cc else core.scan_py(start, n, self.target)

    def _load_state(self) -> dict:
        with contextlib.suppress(OSError, ValueError):
            return json.loads(self.state_path.read_text())
        return {}

    def _save_state(self, s: dict) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(s))
        os.replace(tmp, self.state_path)

    def run_chunk(self, job: dict) -> dict:
        idx, mode, n = int(job["idx"]), job["mode"], int(job["n"])
        st = self._load_state()
        if st.get("idx") != idx or st.get("mode") != mode:
            st = {"idx": idx, "mode": mode, "off": 0, "xor": "00" * 20, "ms": 0}
        start = chunk_start(idx)
        acc = int(st["xor"], 16)
        last_beat = 0.0
        while st["off"] < n and not self.stop_ev.is_set():
            m = min(SLICE, n - st["off"])
            c0, w0 = time.thread_time(), time.perf_counter()
            hit, xo = self._scan(start + st["off"], m)
            cpu, wall = time.thread_time() - c0, time.perf_counter() - w0
            self.cpu_s += cpu
            acc ^= int.from_bytes(xo, "big")
            if hit is not None:
                self.on_hit(hit, idx)
            st["off"] += m
            st["ms"] += int(wall * 1000)
            st["xor"] = f"{acc:040x}"
            self.stats["p71_keys"] += m
            self._rate_win.append((time.monotonic(), m))
            if st["off"] % (SLICE * 64) == 0 or st["off"] >= n:
                self._save_state(st)
            if time.monotonic() - last_beat > BEAT_EVERY:
                last_beat = time.monotonic()
                self.stats["p71_rate"] = int(self.rate())
                with contextlib.suppress(Exception):
                    self.beat()
            # cykl pracy: średnio duty rdzenia (czas CPU wątku, nie zegar ścienny)
            if self.duty < 1.0:
                self.stop_ev.wait(max(cpu, 0.001) * (1.0 / self.duty - 1.0))
        if st["off"] < n:
            return {"ok": False, "reason": "stop"}
        ms = max(st["ms"], 4294)
        r = self.done(idx, mode, st["xor"], n, ms)
        self._save_state({})
        self.stats["p71_chunks"] += 1
        self.last_job = {"kind": mode, "id": idx, "ms": ms, "at": time.time(), "result": r}
        return r or {}

    def loop(self) -> None:
        lower_thread_priority()
        self._register()
        self.log(
            f"p71: start ({self.backend}, {self.pct:g}% z {self.threads} wątków = {self.duty:.2f} rdzenia, nice 19)"
        )
        while not self.stop_ev.is_set():
            try:
                job = self.claim()
                if not job or job.get("error"):
                    self.log(f"p71: brak paczki ({(job or {}).get('error')})")
                    self.stop_ev.wait(900)
                    continue
                r = self.run_chunk(job)
                if r.get("ok"):
                    self.log(
                        f"p71: paczka {job['idx']} ({job['mode']}) zrobiona" + (" – zgodna" if r.get("match") else "")
                    )
            except Exception as e:  # noqa: BLE001 – błąd sieci: następna próba
                self.log(f"p71: błąd: {str(e)[:160]}")
                self.stop_ev.wait(120)

    def start(self) -> threading.Thread:
        t = threading.Thread(target=self.loop, name="p71", daemon=True)
        t.start()
        return t
