"""Most MQTT: urządzenia IoT publikują okna odczytów, agent prognozuje następny odczyt.

Temat wejściowy ``mycelium/sensors/<id>`` (JSON ``{"values": [...]}``),
wyjściowy ``mycelium/forecast/<id>`` (JSON ``{"next": x, "window": n}``).

Zabezpieczenia (OWASP IoT): ID urządzenia z białej listy znaków, limit rozmiaru wiadomości,
odrzucanie NaN/inf, limit wiadomości na urządzenie (token bucket), opcjonalnie login/hasło
(``MQTT_USERNAME`` / ``MQTT_PASSWORD``) i TLS do brokera.

    mosquitto -p 1883 &   python -m iot_mycelium ai-mqtt --host localhost
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import time
from collections.abc import Callable
from typing import Any

IN_TOPIC = "mycelium/sensors/+"
MAX_PAYLOAD = 16 * 1024  # bajtów; 512 liczb zmieści się z zapasem
MAX_VALUES = 512
DEVICE_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

log = logging.getLogger(__name__)


class RateLimiter:
    """Token bucket per urządzenie: ``rate`` wiadomości/s, chwilowo do ``burst``."""

    def __init__(self, rate: float = 5.0, burst: int = 10, clock: Callable[[], float] = time.monotonic) -> None:
        self.rate, self.burst, self.clock = rate, burst, clock
        self._buckets: dict[str, tuple[float, float]] = {}

    def allow(self, key: str) -> bool:
        now = self.clock()
        tokens, last = self._buckets.get(key, (float(self.burst), now))
        tokens = min(self.burst, tokens + (now - last) * self.rate)
        ok = tokens >= 1.0
        self._buckets[key] = (tokens - 1.0 if ok else tokens, now)
        if len(self._buckets) > 10_000:  # ochrona przed zalaniem losowymi ID
            self._buckets.pop(next(iter(self._buckets)))
        return ok


def parse_values(payload: bytes) -> list[float] | None:
    """Payload → skończone liczby (ostatnie ``MAX_VALUES``) albo None, gdy wiadomość jest niepoprawna."""
    if len(payload) > MAX_PAYLOAD:
        return None
    try:
        data = json.loads(payload)
        values = [float(v) for v in data["values"]][-MAX_VALUES:]
    except (ValueError, KeyError, TypeError):
        return None
    if len(values) < 2 or not all(math.isfinite(v) for v in values):
        return None
    return values


def handle(
    topic: str,
    payload: bytes,
    predict: Callable[[list[float]], dict[str, Any]],
    limiter: RateLimiter | None = None,
) -> tuple[str, str] | None:
    """Czysta logika (testowalna bez brokera): wiadomość → (temat odpowiedzi, JSON) albo None."""
    device = topic.rsplit("/", 1)[-1]
    if not DEVICE_RE.fullmatch(device):
        return None
    values = parse_values(payload)
    if values is None:
        return None
    if limiter is not None and not limiter.allow(device):
        return None
    return f"mycelium/forecast/{device}", json.dumps(predict(values))


def serve(
    host: str = "localhost",
    port: int = 1883,
    max_messages: int | None = None,
    tls: bool = False,
    rate: float = 5.0,
) -> int:
    import paho.mqtt.client as mqtt

    from .api import WindowIn, forecast

    count = 0
    limiter = RateLimiter(rate=rate, burst=max(1, int(rate * 2)))

    def predict(values: list[float]) -> dict[str, Any]:
        return forecast(WindowIn(values=values))

    def on_message(client: Any, _u: Any, msg: Any) -> None:
        nonlocal count
        try:
            out = handle(msg.topic, msg.payload, predict, limiter)
            if out:
                client.publish(*out)
        except Exception:  # błąd modelu nie może zatrzymać mostu
            log.exception("prognoza dla %s nie powiodła się", msg.topic)
        count += 1
        if max_messages and count >= max_messages:
            client.disconnect()

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="mycelium-agent")
    if user := os.environ.get("MQTT_USERNAME"):
        client.username_pw_set(user, os.environ.get("MQTT_PASSWORD"))
    if tls:
        client.tls_set()
    client.on_message = on_message
    client.on_connect = lambda c, *_: c.subscribe(IN_TOPIC)
    client.connect(host, port)
    client.loop_forever()
    return count
