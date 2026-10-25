"""Sieć grzybni po stronie Pythona: ten sam pokój Supabase Realtime i ten sam format ramek co przeglądarka (web/src/mesh/net.ts).

Węzeł bez przeglądarki nie zestawia WebRTC (ogłasza rtc=false), więc dane idą przekaźnikiem Realtime.
Przy całym modelu w jednym węźle to tylko kilka małych wiadomości na odpowiedź (prompt → strumień tokenów).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import struct
import time
from collections.abc import Awaitable, Callable

import websockets

SB_URL = "https://agortpieeygmcttjwjfx.supabase.co"
SB_KEY = "sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P"  # klucz publiczny (ten sam co na stronie)
ROOM = "myc-mesh-qwen05-v1"
CHUNK = 48_000
HEARTBEAT_S = float(os.environ.get("MYC_HEARTBEAT_S", "2"))
# brak jakiejkolwiek wiadomości z serwera (także odpowiedzi na bicie serca) przez tyle sekund = martwe połączenie
# (np. po przywróceniu komputera z migawki gniazdo TCP wygląda na otwarte, ale nic już nie przychodzi)
DEAD_S = float(os.environ.get("MYC_DEAD_S", str(max(30.0, 10 * HEARTBEAT_S))))
DEBUG = bool(os.environ.get("MYC_DEBUG"))
# Limity składania wiadomości od obcych (pokój jest publiczny): bez nich wystarczyłoby wysyłać pierwsze ramki
# z ogromnym `tot`, żeby zająć pamięć węzła. Największa prawdziwa wiadomość (stan warstw) to kilka MB.
MAX_FRAMES = 256  # 256 × 48 kB ≈ 12 MB na wiadomość
MAX_PENDING = 64  # niedokończonych wiadomości naraz (wszyscy nadawcy)
PENDING_S = 60.0

Handler = Callable[[str, dict, bytes | None], Awaitable[None]]


def pack(m: dict, b: bytes | None = None) -> bytes:
    h = json.dumps(m, separators=(",", ":")).encode()
    return struct.pack("<I", len(h)) + h + (b or b"")


def unpack(u: bytes) -> tuple[dict, bytes | None]:
    n = struct.unpack_from("<I", u)[0]
    rest = u[4 + n :]
    return json.loads(u[4 : 4 + n]), (rest or None)


class DeadConnection(ConnectionError):
    pass


async def recv_or_dead(ws, dead_s: float):
    """Odbierz wiadomość; gdy serwer milczy dłużej niż dead_s (mimo bicia serca), uznaj połączenie za martwe."""
    try:
        return await asyncio.wait_for(ws.recv(), timeout=dead_s)
    except TimeoutError:
        raise DeadConnection(f"brak odpowiedzi serwera od {dead_s:.0f} s") from None


class Net:
    def __init__(self, me: str, state: dict, on_msg: Handler, room: str = ROOM, log=print):
        self.me, self.state, self.on_msg, self.room, self.log = me, state, on_msg, room, log
        self.topic = f"realtime:{room}"
        self.presence: dict[str, dict] = {}
        self.ws = None
        self.ref = 0
        self.seq = 0
        self.parts: dict[tuple[str, int], tuple[float, list]] = {}
        self.sent = 0
        self.last_send = 0.0
        self.joined = False
        self.drops = 0

    def _ref(self) -> str:
        self.ref += 1
        return str(self.ref)

    async def _push(self, event: str, payload: dict):
        # po zerwaniu połączenia poczekaj na ponowne dołączenie (do 15 s), zamiast gubić wiadomość
        for _ in range(150):
            if self.ws is not None and self.joined:
                break
            await asyncio.sleep(0.1)
        else:
            raise ConnectionError("brak połączenia z Realtime")
        # łagodny limit (Realtime: do kilkudziesięciu wiadomości na sekundę na klienta)
        wait = self.last_send + 0.025 - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self.last_send = time.monotonic()
        msg = {
            "topic": self.topic,
            "event": "broadcast",
            "payload": {"type": "broadcast", "event": event, "payload": payload},
            "ref": self._ref(),
        }
        try:
            await self.ws.send(json.dumps(msg, separators=(",", ":")))
        except Exception:  # noqa: BLE001 – połączenie zerwane w trakcie: jedna ponowna próba po dołączeniu
            self.joined = False
            await asyncio.sleep(1)
            return await self._push(event, payload)
        self.sent += 1

    async def beat(self, hello=False):
        await self._push("hb", {**self.state, "at": int(time.time() * 1000), "hello": hello})

    async def send(self, to: str, m: dict, b: bytes | None = None):
        u = pack(m, b)
        tot = max(1, -(-len(u) // CHUNK))
        self.seq += 1
        for i in range(tot):
            f = struct.pack("<IHH", self.seq, i, tot) + u[i * CHUNK : (i + 1) * CHUNK]
            await self._push("relay", {"to": to, "from": self.me, "f": base64.b64encode(f).decode()})

    async def _recv_frame(self, frm: str, f: bytes):
        if len(f) < 8 or len(f) > CHUNK + 8 or not isinstance(frm, str) or len(frm) > 64:
            return
        mid, idx, tot = struct.unpack_from("<IHH", f)
        if not 0 < tot <= MAX_FRAMES or idx >= tot:
            return
        key = (frm, mid)
        now = time.monotonic()
        if key not in self.parts:
            for k in [k for k, (t, _) in self.parts.items() if now - t > PENDING_S]:
                del self.parts[k]
            if len(self.parts) >= MAX_PENDING:
                return
            self.parts[key] = (now, [None] * tot)
        _, arr = self.parts[key]
        if len(arr) != tot:
            return
        arr[idx] = f[8:]
        if all(p is not None for p in arr):
            del self.parts[key]
            try:
                m, b = unpack(b"".join(arr))
            except (ValueError, struct.error, UnicodeDecodeError):
                return
            if isinstance(m, dict):
                asyncio.create_task(self.on_msg(frm, m, b))

    async def run(self, stop: asyncio.Event):
        url = SB_URL.replace("https", "wss") + f"/realtime/v1/websocket?apikey={SB_KEY}&vsn=1.0.0"
        backoff = 1
        while not stop.is_set():
            try:
                async with websockets.connect(url, max_size=8 << 20, ping_interval=None, close_timeout=3) as ws:
                    self.ws = ws
                    cfg = {
                        "config": {
                            "broadcast": {"self": False, "ack": False},
                            "presence": {"key": ""},
                            "private": False,
                        }
                    }
                    await ws.send(
                        json.dumps({"topic": self.topic, "event": "phx_join", "payload": cfg, "ref": self._ref()})
                    )
                    tasks = [asyncio.create_task(self._heartbeats(ws)), asyncio.create_task(self._beats())]
                    joined = self.joined = False
                    try:
                        while True:
                            raw = await recv_or_dead(ws, DEAD_S)
                            msg = json.loads(raw)
                            ev = msg.get("event")
                            if ev == "phx_reply" and not joined and msg.get("payload", {}).get("status") == "ok":
                                joined = self.joined = True
                                backoff = 1
                                self.log("połączono z grzybnią (Realtime)")
                                await self.beat(hello=True)
                            elif ev == "broadcast":
                                await self._broadcast(msg["payload"])
                            elif DEBUG and ev not in ("presence_state", "presence_diff"):
                                self.log("ws", ev, str(msg.get("payload"))[:200])
                            if ev in ("phx_error", "phx_close"):
                                raise ConnectionError(ev)
                    finally:
                        for t in tasks:
                            t.cancel()
            except Exception as e:  # noqa: BLE001 – każdy błąd sieci: ponów z opóźnieniem
                self.ws, self.joined = None, False
                self.drops += 1
                if DEBUG or backoff > 1 or isinstance(e, DeadConnection):
                    self.log(f"rozłączono ({type(e).__name__}: {e}); ponawiam za {backoff} s")
                await asyncio.sleep(backoff if backoff > 1 else 0.2)
                backoff = min(60, backoff * 2)

    async def _heartbeats(self, ws):
        # częste bicie serca Phoenix: niektóre sieci (NAT, proxy) zrywają cichy WebSocket już po kilku sekundach
        while True:
            await asyncio.sleep(HEARTBEAT_S)
            await ws.send(json.dumps({"topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": self._ref()}))

    async def _beats(self):
        while True:
            await asyncio.sleep(5)
            await self.beat()
            now = time.time()
            for k in [k for k, p in self.presence.items() if now - p["_seen"] > 20]:
                del self.presence[k]

    async def _broadcast(self, p: dict):
        ev, pl = p.get("event"), p.get("payload") or {}
        if DEBUG and ev != "hb":
            self.log("<-", ev, str(pl)[:160])
        if ev == "hb" and pl.get("node") != self.me:
            new = pl["node"] not in self.presence
            self.presence[pl["node"]] = {**pl, "_seen": time.time()}
            if new or pl.get("hello"):
                await self.beat()
        elif ev == "bye":
            self.presence.pop(pl.get("node"), None)
        elif ev == "relay" and pl.get("to") == self.me:
            await self._recv_frame(pl["from"], base64.b64decode(pl["f"]))

    async def bye(self):
        if self.ws:
            await self._push("bye", {"node": self.me})
