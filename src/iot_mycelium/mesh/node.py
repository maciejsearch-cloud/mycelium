"""Węzeł grzybni bez przeglądarki (PC, serwer, Raspberry Pi).

    python -m iot_mycelium.node --join

Trzyma cały model Qwen2.5-0.5B (bf16, ok. 1 GB RAM) i odpowiada w czacie grzybni: przyjmuje prompt,
liczy go jednym przejściem i strumieniuje tokeny. Obsługuje też pojedyncze fragmenty (embed/layers/logits),
więc może zastąpić brakujące fragmenty w trasie złożonej z przeglądarek. Pamięć K/V trzyma osobno dla rozmowy.
Stan zapisuje co 30 s w ~/.cache/mycelium/node-<id>.json (dziennik dla usług i strony) i pokazuje go
na lokalnej stronie http://127.0.0.1:8765 (tylko ten komputer).

Model językowy grzybni (lmwork.py): węzeł trenuje adapter LoRA na zadaniach z kolejki, ocenia kandydatów innych
węzłów i odpowiada w czacie najnowszą zweryfikowaną wersją. --no-train: tylko czat i ocena.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import platform
import re
import signal
import sys
import threading
import time
import uuid

import torch

from .lm import tobytes
from .net import Net
from .qwen import EMB_PARTS_DEFAULT, HIDDEN, LAYERS, VOCAB, Qwen, Session, cache_dir, ensure_weights
from .status import serve_status

LAYERS_PER_SHARD = 3
SHARDS = [f"L{i}" for i in range(LAYERS // LAYERS_PER_SHARD)] + [f"E{i}" for i in range(EMB_PARTS_DEFAULT)]


SHARD_RE = re.compile(r"^(L[0-7]|E[0-3])$")
MAX_CTX = 4096  # tokenów na wiadomość / rozmowę


def _sig(m: dict) -> str:
    """Odcisk treści żądania 'gen' (rozmowa + tokeny promptu) – odróżnia ponowienie od nowego pytania z tym samym rid."""
    return hashlib.sha256(f"{m.get('conv', '')}|{m.get('ids')}".encode()).hexdigest()[:16]


def _check_ids(ids) -> None:
    if (
        not isinstance(ids, list)
        or not 0 < len(ids) <= MAX_CTX
        or not all(isinstance(t, int) and 0 <= t < VOCAB for t in ids)
    ):
        raise ValueError("bad-ids")


def emb_range(i: int) -> tuple[int, int]:
    per = -(-VOCAB // EMB_PARTS_DEFAULT)
    return i * per, min(VOCAB, (i + 1) * per)


class Node:
    def __init__(self, model: Qwen, node_id: str, label: str, log=print):
        self.m, self.id, self.log = model, node_id, log
        self.stats = {
            "started": time.time(),
            "chats": 0,
            "tokens": 0,
            "shard_calls": 0,
            "last": None,
            "tps": None,
            "first_ms": None,
        }
        state = {
            "node": node_id,
            "role": "node",
            "cap": len(SHARDS),
            "backend": f"cpu-torch-{torch.get_num_threads()}t",
            "shards": dict.fromkeys(SHARDS, "ready"),
            "full": True,
            "rtc": False,
            "kind": "headless",
            "label": label,
        }
        self.net = Net(node_id, state, self.on_msg, log=log)
        self.kv: dict[str, Session] = {}
        self.lock = asyncio.Lock()
        self.stops: set[str] = set()
        # stan odpowiedzi na żądania 'gen' (do ponownego wysłania po zerwaniu połączenia), 10 min
        self.gens: dict[str, dict] = {}
        self.lmw = None  # LMWorker (model językowy grzybni)
        self.taxw = None  # TaxoWorker (samoorganizująca się taksonomia słów)
        self.rbw = None  # RozbiorWorker (rozbiór zdań – warstwa rozumienia)

    def _kv(self, key: str, start: int) -> Session:
        s = self.kv.get(key)
        if s is None or start == 0:
            s = self.kv[key] = Session()
            while len(self.kv) > 96:
                del self.kv[min(self.kv, key=lambda k: self.kv[k].at)]
        if len(s.tokens) != start:
            raise ValueError(f"kv:{len(s.tokens)}")
        return s

    async def on_msg(self, frm: str, m: dict, b: bytes | None):
        k, rid = m.get("k"), m.get("rid")
        key = f"{frm}:{rid}"
        if k == "stop":
            self.stops.add(key)
            return
        # ponowione żądanie 'gen' = ten sam nadawca, rid ORAZ ta sama treść (rozmowa + tokeny promptu); inna treść pod tym
        # samym kluczem (klient po przeładowaniu liczy rid od nowa) to nowe pytanie – nie odtwarzamy starej odpowiedzi
        if k == "poll" or (
            k == "req" and m.get("op") == "gen" and key in self.gens and self.gens[key].get("sig") == _sig(m)
        ):
            # klient nie dostał części strumienia (zerwane połączenie): wyślij aktualny stan jeszcze raz
            await self._gen_state(frm, rid, key)
            return
        if k != "req":
            return
        if not self.net.state.get("cap"):  # moc obliczeniowa wyłączona w panelu: klient wybierze inny węzeł
            with contextlib.suppress(ConnectionError):
                await self.net.send(frm, {"k": "res", "rid": rid, "err": "busy"})
            return
        try:
            async with self.lock:  # jedno zadanie naraz na tym CPU
                if m.get("op") == "gen":
                    self.gens[key] = {"ids": [], "res": None, "at": time.time(), "sig": _sig(m)}
                    with contextlib.suppress(ConnectionError):
                        await self.net.send(frm, {"k": "ack", "rid": rid})
                    await self._gen(frm, m)
                    return
                t0 = time.perf_counter()
                y, top = await asyncio.to_thread(self._shard_op, m, b)
                self.stats["shard_calls"] += 1
            await self.net.send(frm, {"k": "res", "rid": rid, "ms": (time.perf_counter() - t0) * 1000, "top": top}, y)
        except Exception as e:  # noqa: BLE001 – błąd wraca do klienta, który wybierze inny węzeł
            await self.net.send(frm, {"k": "res", "rid": rid, "err": str(e)})

    @torch.inference_mode()
    def _shard_op(self, m: dict, b: bytes | None):
        # wiadomości z publicznego pokoju to tylko dane: sprawdzamy typy, zakresy i rozmiary (bez wykonywania kodu)
        s, op, conv, start = m.get("shard"), m.get("op"), str(m.get("conv", ""))[:128], int(m.get("start", 0))
        if not isinstance(s, str) or not SHARD_RE.match(s) or not 0 <= start <= MAX_CTX:
            raise ValueError("bad-shard")
        i = int(s[1:])
        if op == "embed":
            _check_ids(m.get("ids"))
        elif b is None or len(b) % (4 * HIDDEN) or len(b) > 4 * HIDDEN * MAX_CTX:
            raise ValueError("bad-input")
        if op == "embed" and s[0] == "E":
            lo, hi = emb_range(i)
            ids = torch.tensor(m["ids"])
            out = torch.zeros(len(ids), HIDDEN)
            sel = (ids >= lo) & (ids < hi)
            if sel.any():
                out[sel] = self.m.emb[ids[sel]].float()
            return tobytes(out), None
        if op == "layers" and s[0] == "L":
            x = torch.frombuffer(bytearray(b), dtype=torch.float32).view(-1, HIDDEN)
            sess = self._kv(f"{s}|{conv}", start)
            h = self.m.layers(x.to(self.m.dtype), sess, i * LAYERS_PER_SHARD, (i + 1) * LAYERS_PER_SHARD, p0=start)
            sess.tokens.extend([0] * x.shape[0])
            if (i + 1) * LAYERS_PER_SHARD == LAYERS:
                h = self.m._rms(h, self.m.norm)
            return tobytes(h.float()), None
        if op == "logits" and s[0] == "E":
            lo, hi = emb_range(i)
            x = torch.frombuffer(bytearray(b), dtype=torch.float32)[:HIDDEN].to(self.m.dtype)
            z = (self.m.emb[lo:hi] @ x).float()
            t = torch.topk(z, 40)
            return None, [[lo + int(j), float(v)] for v, j in zip(t.values, t.indices, strict=True)]
        raise ValueError("bad-op")

    async def _gen_state(self, frm: str, rid, key: str):
        g = self.gens.get(key)
        if g is None:
            await self.net.send(frm, {"k": "res", "rid": rid, "err": "unknown-rid"})
        elif g["res"] is not None:
            await self.net.send(frm, {"k": "tok", "rid": rid, "ids": g["ids"], "all": True})
            await self.net.send(frm, g["res"])
        else:
            await self.net.send(frm, {"k": "tok", "rid": rid, "ids": g["ids"], "all": True})

    async def _gen(self, frm: str, m: dict):
        rid = m.get("rid")
        key = f"{frm}:{rid}"
        g = self.gens[key]
        for k in [k for k, v in self.gens.items() if time.time() - v["at"] > 600]:
            del self.gens[k]
        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()
        res: dict = {}

        _check_ids(m.get("ids"))

        def work():
            r = self.m.generate(
                f"{frm}|{str(m.get('conv', ''))[:128]}",
                list(m["ids"]),
                max_new=min(int(m.get("maxNew", 200)), 400),
                temp=min(2.0, max(0.0, float(m.get("temp", 0.4)))),
                on_token=lambda t: loop.call_soon_threadsafe(q.put_nowait, t),
                stop=lambda: key in self.stops,
            )
            res.update(r)
            loop.call_soon_threadsafe(q.put_nowait, None)

        th = asyncio.create_task(asyncio.to_thread(work))
        sent = 0
        last = time.monotonic()
        while True:
            t = await q.get()
            if t is not None:
                g["ids"].append(t)
            # pierwszy token od razu, potem co ok. 150 ms wszystkie dotychczasowe tokeny (zgubiona paczka nie psuje tekstu)
            if len(g["ids"]) > sent and (t is None or sent == 0 or time.monotonic() - last > 0.15):
                with contextlib.suppress(ConnectionError):  # klient dopyta (poll)
                    await self.net.send(frm, {"k": "tok", "rid": rid, "ids": list(g["ids"]), "all": True})
                sent, last = len(g["ids"]), time.monotonic()
            if t is None:
                break
        await th
        self.stops.discard(key)
        n = len(res.get("tokens", []))
        self.stats.update(
            chats=self.stats["chats"] + 1,
            tokens=self.stats["tokens"] + n,
            last=time.time(),
            tps=res.get("tps"),
            first_ms=res.get("first_ms"),
        )
        self.log(
            f"rozmowa: prompt {res.get('prompt')} tok (z pamięci K/V {res.get('reused')}), pierwszy token {res.get('first_ms', 0):.0f} ms, {n} tok, {res.get('tps', 0):.1f} tok/s"
        )
        g["res"] = {
            "k": "res",
            "rid": rid,
            "done": True,
            "n": n,
            "tps": res.get("tps"),
            "firstMs": res.get("first_ms"),
            "reused": res.get("reused"),
            "prompt": res.get("prompt"),
        }
        with contextlib.suppress(ConnectionError):
            await self.net.send(frm, g["res"])

    def status(self) -> dict:
        return {
            **self.stats,
            **(self.lmw.stats if self.lmw else {}),
            "lm_last": self.lmw.last_job if self.lmw else None,
            **(self.taxw.stats if self.taxw else {}),
            "taxo_last": self.taxw.last_job if self.taxw else None,
            **(self.rbw.stats if self.rbw else {}),
            "rb_last": self.rbw.last_job if self.rbw else None,
            "label": self.net.state.get("label"),
            "backend": self.net.state.get("backend"),
            "id": self.id,
            "drops": self.net.drops,
            "now": time.time(),
            "peers": len(self.net.presence),
            "connected": self.net.ws is not None,
            "nodes_online": 1 + sum(1 for x in self.net.presence.values() if x.get("cap", 0) > 0),
        }

    def write_status(self):
        p = cache_dir() / f"node-{self.id[:8]}.json"
        p.write_text(json.dumps(self.status()))

    async def telemetry(self, panel, stop: asyncio.Event):
        """Co 2 s: pomiar CPU/GPU/RAM, zdarzenia do historii (zadania, połączenie), prośba o restart z panelu."""
        seen: dict[str, float] = {}
        was = None
        while not stop.is_set():
            s = await asyncio.to_thread(panel.monitor.sample)
            s["busy"] = panel.sched.view()["busy_pct"]
            conn = self.net.ws is not None
            if conn != was:
                if was is not None or conn:
                    panel.history.add("net", "połączono z grzybnią" if conn else "rozłączono – ponawiam")
                was = conn
            for name, w in (("lm", self.lmw), ("taxo", self.taxw), ("rozbior", self.rbw)):
                j = getattr(w, "last_job", None) if w else None
                if j and j.get("at") and j["at"] != seen.get(name):
                    seen[name] = j["at"]
                    if name == "lm":
                        msg = f"model językowy: {j.get('kind')}{' (destylacja)' if j.get('kd') else ''} v{j.get('version')}"
                    elif name == "rozbior":
                        msg = f"rozbiór zdań: {j.get('kind')} v{j.get('version')}"
                    else:
                        msg = "słowa/strzępki: grupowanie i weryfikacja"
                    panel.history.add("job", msg, ms=j.get("ms"), job=j.get("id"), result=j.get("result"), area=name)
            if panel.restart_req.is_set():
                self.log("ponowne uruchomienie na prośbę panelu")
                stop.set()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), panel.monitor.every)

    async def run(self, status_port: int = 0, panel=None):
        stop = asyncio.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError, RuntimeError):  # Windows: brak add_signal_handler
                asyncio.get_running_loop().add_signal_handler(sig, stop.set)
        if status_port and panel is None:
            port = serve_status(self.status, status_port)
            if port:
                self.log(f"stan węzła: http://127.0.0.1:{port}")

        async def status():
            while not stop.is_set():
                await asyncio.sleep(30)
                self.write_status()

        async def presence():
            # prawdziwy ślad obecności do wykresu „węzły w czasie”: wiersz co 6 h (MYC_NO_PRESENCE=1 wyłącza)
            while not stop.is_set():
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(log_presence, self.id)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(stop.wait(), 6 * 3600)

        tasks = [asyncio.create_task(self.net.run(stop)), asyncio.create_task(status())]
        if panel is not None:
            tasks.append(asyncio.create_task(self.telemetry(panel, stop)))
        if self.lmw:
            tasks.append(asyncio.create_task(self.lmw.run(stop)))
        if self.taxw:
            tasks.append(asyncio.create_task(self.taxw.run(stop)))
        if self.rbw:
            tasks.append(asyncio.create_task(self.rbw.run(stop)))
        if getattr(self, "pasw", None):
            tasks.append(asyncio.create_task(self.pasw.run(stop)))
        if not os.environ.get("MYC_NO_PRESENCE"):
            tasks.append(asyncio.create_task(presence()))
        with contextlib.suppress(KeyboardInterrupt, asyncio.CancelledError):
            await stop.wait()
        with contextlib.suppress(Exception):
            await self.net.bye()
        for t in tasks:
            t.cancel()


def log_presence(nid: str) -> None:
    """Wiersz myc_growth (kind=python, event=action) – węzeł bez przeglądarki był online."""
    import urllib.request

    from .net import SB_KEY, SB_URL

    body = {
        "node_id": nid,
        "kind": "python",
        "event": "action",
        "detail": {"what": "mesh-node", "model": "qwen2.5-0.5b", "threads": torch.get_num_threads()},
    }
    req = urllib.request.Request(  # noqa: S310 – stały adres https Supabase
        f"{SB_URL}/rest/v1/myc_growth",
        data=json.dumps(body).encode(),
        headers={"apikey": SB_KEY, "Content-Type": "application/json", "Prefer": "return=minimal"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=15).close()  # noqa: S310


def node_id(name: str) -> str:
    p = cache_dir() / f"node-id-{name}"
    if p.exists():
        return p.read_text().strip()
    p.parent.mkdir(parents=True, exist_ok=True)
    i = str(uuid.uuid4())
    p.write_text(i)
    return i


def low_priority() -> None:
    """Niższy priorytet procesu: komputer pozostaje responsywny (nice 10 / BELOW_NORMAL na Windows)."""
    with contextlib.suppress(Exception):
        if os.name == "nt":
            import ctypes

            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
        else:
            os.nice(10)


def gpu_cli(argv: list[str]) -> int:
    """--gpu-info: karty i odczyt użycia; --gpu-bench: dodatkowo test treningu CPU vs DirectML (JSON na wyjściu)."""
    from . import gpu, sysmon

    mon = sysmon.Monitor()
    mon.sample()
    time.sleep(1.5)
    mon.sample()
    out = {
        "adapters": mon.gpus(),
        "util_error": mon.util_error(),
        "caps": sysmon.capabilities(),
        "directml": gpu.dml_available(),
        "dml_name": gpu.dml_name(),
        "dml_error": gpu.dml_error(),
    }
    if "--gpu-bench" in argv:
        from .lmwork import Data

        torch.set_num_threads(max(1, min(4, (os.cpu_count() or 2) - 1)))
        m = Qwen(ensure_weights(lambda *a: print(*a, file=sys.stderr)), torch.bfloat16)
        ids, mask = Data().shard(0)
        out["bench"] = gpu.benchmark(m, ids[:2], mask[:2], log=lambda *a: None)
    print(json.dumps(out, indent=1, default=str))  # ASCII: konsola Windows bywa cp1252
    return 0


def main(argv=None):

    argv = sys.argv[1:] if argv is None else argv
    if "--verify-lm" in argv:
        from .lmverify import main as verify

        sys.exit(verify([x for x in argv if x != "--verify-lm"]))
    if "--selfupdate-selftest" in argv:  # test wydania: biblioteka podpisów obecna w pliku wykonywalnym
        from .selfupdate import signature_lib_ok

        sys.exit(0 if signature_lib_ok() else 1)
    if "--install" in argv or "--uninstall" in argv:
        from .service import main as service

        sys.exit(service(argv))
    for stream in (sys.stdout, sys.stderr):  # konsola Windows bez UTF-8: polskie znaki nie mogą zatrzymać węzła
        with contextlib.suppress(Exception):
            stream.reconfigure(errors="replace")
    if "--gpu-info" in argv or "--gpu-bench" in argv:  # diagnostyka GPU (też test w CI wydania)
        sys.exit(gpu_cli(argv))
    if "--ui" in argv:  # okno panelu działającego węzła (albo start aplikacji, gdy węzeł nie działa)
        from .service import open_ui

        sys.exit(open_ui(argv))
    if "--join" not in argv and set(argv) <= {"--run", "--headless", "--no-self-update"}:
        # aplikacja (dwuklik / autostart): pierwsze uruchomienie pyta o ustawienia, potem nadzorca z restartem
        from .service import run_app

        sys.exit(run_app(argv))
    ap = argparse.ArgumentParser(
        prog="mycelium-node", description="Węzeł grzybni: model językowy na CPU (czat + trening), bez przeglądarki."
    )
    ap.add_argument("--join", action="store_true", help="dołącz do grzybni (wymagane)")
    ap.add_argument("--name", default="default", help="nazwa lokalna (osobne id dla kilku węzłów na jednej maszynie)")
    ap.add_argument("--threads", type=int, default=max(1, min(4, (os.cpu_count() or 2) - 1)))
    ap.add_argument("--dtype", choices=["bf16", "f32"], default="bf16")
    ap.add_argument("--no-train", action="store_true", help="bez treningu modelu językowego (tylko czat i ocena)")
    ap.add_argument("--no-lm", action="store_true", help="bez zadań modelu językowego (tylko czat)")
    ap.add_argument("--no-taxo", action="store_true", help="bez grupowania słów (taksonomia)")
    ap.add_argument("--no-rozbior", action="store_true", help="bez rozbioru zdań (warstwa rozumienia)")
    ap.add_argument(
        "--max-ram-gb",
        type=float,
        default=0,
        help="limit RAM: 2–4 GB: trening po 2 sekwencje naraz (ok. 3 GB), < 2 GB: bez treningu",
    )
    ap.add_argument("--status-port", type=int, default=8765, help="lokalna strona stanu i panel (0 = wyłączone)")
    ap.add_argument("--normal-priority", action="store_true", help="bez obniżania priorytetu procesu")
    ap.add_argument("--headless", action="store_true", help="bez okna panelu (serwery); strona stanu zostaje")
    a = ap.parse_args(argv)
    if not a.join:
        ap.error("dodaj --join, aby dołączyć do grzybni")
    if not a.normal_priority:
        low_priority()

    from .account import NodeAccount
    from .dashboard import RESTART_CODE, Api, Panel, ui_info_path, ui_token
    from .history import History
    from .sched import defaults
    from .sysmon import Monitor

    nid = node_id(a.name)
    hist = History(a.name)
    panel: Panel | None = None

    def log(*x):
        line = " ".join(str(v) for v in x)
        print(time.strftime("%Y-%m-%d %H:%M:%S"), f"[{a.name}]", line, flush=True)
        if panel is not None:
            panel.line(f"{time.strftime('%H:%M:%S')} {line}")
            hist.add("error" if ("błąd" in line or "nieudane" in line) else "log", line)

    panel = Panel(a.name, nid, defaults(a.threads, a.max_ram_gb), hist, Monitor(), NodeAccount(nid, log=log), log=log)
    al = panel.alloc  # ustawienia z panelu (alloc-<nazwa>.json) mają pierwszeństwo przed wierszem poleceń
    torch.set_num_threads(int(al["threads"]))
    ram = float(al["ram_gb"])
    if a.status_port:
        api = Api(panel, ui_token())
        port = serve_status(
            lambda: panel.node.status() if panel.node else {"phase": panel.phase, "connected": False, "id": nid},
            a.status_port,
            api,
        )
        if port:
            ui_info_path(a.name).write_text(json.dumps({"port": port, "pid": os.getpid()}))
            log(f"stan węzła: http://127.0.0.1:{port}  (panel: {a.name}: MyceliumNode --ui)")
    hist.add("net", f"start węzła {nid[:8]} ({al['threads']} wątki, RAM {f'{ram} GB' if ram else 'bez limitu'})")

    log("ładuję model (pierwszy raz pobiera ok. 988 MB z Hugging Face, ze wznawianiem i sumą SHA-256)…")
    m = Qwen(ensure_weights(log), torch.bfloat16 if a.dtype == "bf16" else torch.float32)
    n = Node(m, nid, f"{platform.node()}/{a.name}", log)
    train = not a.no_train and not (0 < ram < 2)
    micro = 2 if 0 < ram < 4 else None
    if not a.no_lm:
        from .lmwork import LMWorker

        n.lmw = LMWorker(n, train=train, log=log, micro=micro)
    if not a.no_taxo:
        from .taxwork import TaxoWorker

        n.taxw = TaxoWorker(n, log=log)
    if not a.no_rozbior and train:
        from .rbwork import RozbiorWorker

        n.rbw = RozbiorWorker(n, log=log)
    from .passive import PassiveWorker

    n.pasw = panel.passive = PassiveWorker(n, panel, log=log)
    if not al.get("compute_on", True):
        n.net.state["cap"] = 0  # bez oddawania mocy: nie przyjmuje rozmów
    panel.attach(n)
    threading.Thread(target=panel.account.refresh, daemon=True).start()
    log(
        f"gotowy: węzeł {n.id[:8]}, {al['threads']} wątki CPU, cały model (12/12 fragmentów), "
        f"model językowy: {'trening + ocena' if train and not a.no_lm else 'ocena' if not a.no_lm else 'wyłączony'}"
    )
    asyncio.run(n.run(a.status_port, panel))
    if panel.restart_req.is_set():
        sys.exit(RESTART_CODE)


if __name__ == "__main__":
    main()
