"""Eksport danych do nauki z pytań (frontend + Python node).

Tworzy:
* ``web/public/data/qa.json`` – publiczne: zestaw startowy, zbiór testowy i pytania
  (BEZ odpowiedzi do pytań kontrolnych),
* ``.gold/qa.json`` – odpowiedzi kontrolne (gold) tylko dla bazy (poza repo; ``scripts/gold_rotate.py`` ładuje je
  do ``myc_gold``, nieczytelnej dla klientów). Pula losowana z tajnego ``MYC_GOLD_SEED`` (scripts/goldkit.py).

Dane: CLINC150 (intencje, prawdziwe wypowiedzi) i NAB machine_temperature
(prawdziwa awaria maszyny z oznaczonymi oknami anomalii).
"""

from __future__ import annotations

import csv
import json
import random
import sys
from datetime import datetime
from pathlib import Path

from iot_mycelium.ai.datasets import datasets_dir

sys.path.insert(0, str(Path(__file__).resolve().parent))
import goldkit  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
INTENTS = [
    "weather",
    "alarm",
    "timer",
    "play_music",
    "translate",
    "calendar",
    "restaurant_reservation",
    "travel_alert",
    "smart_home",
    "change_volume",
]
INTENT_PL = {
    "weather": "pogoda",
    "alarm": "budzik",
    "timer": "minutnik",
    "play_music": "muzyka",
    "translate": "tłumaczenie",
    "calendar": "kalendarz",
    "restaurant_reservation": "rezerwacja stolika",
    "travel_alert": "ostrzeżenia w podróży",
    "smart_home": "inteligentny dom",
    "change_volume": "głośność",
}
SEG, STRIDE, CTX = 48, 24, 288  # 4 h okna co 2 h, kontekst 24 h (próbki co 5 min)

# Wiedza ogólna: (id, pl, en, gold | None). None = rozstrzyga konsensus węzłów. Od rundy 2 wszystkie pytania wiedzy
# rozstrzyga konsensus – odpowiedzi kontrolnych nie trzymamy w repozytorium (k01–k10 miały je jawne w rundzie 1).
KNOWLEDGE = [
    ("k01", "Warszawa jest stolicą Polski.", "Warsaw is the capital of Poland.", None),
    ("k02", "Woda wrze w 100°C na poziomie morza.", "Water boils at 100°C at sea level.", None),
    ("k03", "Słońce krąży wokół Ziemi.", "The Sun orbits the Earth.", None),
    ("k04", "Wisła wpada do Morza Bałtyckiego.", "The Vistula flows into the Baltic Sea.", None),
    ("k05", "Pająki to owady.", "Spiders are insects.", None),
    ("k06", "Amsterdam leży w Belgii.", "Amsterdam is in Belgium.", None),
    ("k07", "Ryga jest stolicą Łotwy.", "Riga is the capital of Latvia.", None),
    ("k08", "Grzybnia to podziemna część grzyba.", "Mycelium is the underground part of a fungus.", None),
    ("k09", "Światło jest szybsze od dźwięku.", "Light is faster than sound.", None),
    (
        "k10",
        "Raspberry Pi to rodzaj ciasta, którego nie da się zaprogramować.",
        "A Raspberry Pi is a pie that cannot be programmed.",
        None,
    ),
    ("k11", "Gołdap leży w województwie warmińsko-mazurskim.", "Gołdap is in the Warmian-Masurian Voivodeship.", None),
    ("k12", "Temperatura 35°C w serwerowni to stan alarmowy.", "35°C in a server room is an alarm condition.", None),
    (
        "k13",
        "Wilgotność powyżej 70% sprzyja pleśni w mieszkaniu.",
        "Humidity above 70% encourages mould at home.",
        None,
    ),
    (
        "k14",
        "Czujnik CO2 powyżej 1500 ppm sygnalizuje potrzebę wietrzenia.",
        "A CO2 reading above 1500 ppm means the room needs airing.",
        None,
    ),
    (
        "k15",
        "Uczenie federacyjne wymaga wysyłania surowych danych na serwer.",
        "Federated learning requires sending raw data to a server.",
        None,
    ),
    ("k16", "MQTT to lekki protokół dla IoT.", "MQTT is a lightweight IoT protocol.", None),
    ("k17", "Bateria litowa lubi mróz.", "Lithium batteries like frost.", None),
    ("k18", "Gołdap ma status uzdrowiska.", "Gołdap has spa-town status.", None),
    ("k19", "Holandia ma więcej rowerów niż mieszkańców.", "The Netherlands has more bicycles than people.", None),
    ("k20", "Wi-Fi 2,4 GHz ma większy zasięg niż 5 GHz.", "2.4 GHz Wi-Fi has a longer range than 5 GHz.", None),
    (
        "k21",
        "Ruch w czujniku PIR w nocy zawsze oznacza włamanie.",
        "PIR motion at night always means a burglary.",
        None,
    ),
    ("k22", "Lodówka powinna mieć ok. 4°C.", "A fridge should be about 4°C.", None),
]


def intents(rng: random.Random, grng: random.Random) -> tuple[list, list, list, dict]:
    d = json.loads((datasets_dir() / "data_small.json").read_text())
    by: dict[str, list[str]] = {k: [] for k in INTENTS}
    for text, lab in d["train"] + d["val"]:
        if lab in by:
            by[lab].append(text)
    test = [[t, INTENTS.index(lab)] for t, lab in d["test"] if lab in by]
    seed, pool, pool1 = [], [], []
    for k, texts in by.items():
        rng.shuffle(texts)
        seed += [[t, INTENTS.index(k)] for t in texts[:3]]
        pool1 += [(t, INTENTS.index(k)) for t in texts[3:15]]  # runda 1 (jawna) – już nie jest pulą
        spare = texts[15:]
        grng.shuffle(spare)
        pool += [(t, INTENTS.index(k)) for t in spare[:12]]
    rng.shuffle(pool1)
    rng.shuffle(test)
    grng.shuffle(pool)
    qs, gold = [], {}
    for i, (t, y) in enumerate(pool):
        qid = goldkit.rid("i", i, 4)
        qs.append({"id": qid, "text": t})
        gold[qid] = INTENTS[y]
    return seed, test[:300], qs, gold


def sensor(rng: random.Random, grng: random.Random) -> tuple[list, list, list, dict]:
    name = "machine_temperature_system_failure.csv"
    rows = list(csv.reader((datasets_dir() / name).open()))[1:]
    ts = [datetime.fromisoformat(r[0]) for r in rows]
    vals = [float(r[1]) for r in rows]
    wins = json.loads((datasets_dir() / "combined_windows.json").read_text())[f"realKnownCause/{name}"]
    centers = []
    for a, b in wins:
        a, b = datetime.fromisoformat(a), datetime.fromisoformat(b)
        third = (b - a) / 3
        centers.append((a + third, b - third))
    items, items2 = [], []
    for s in range(CTX, len(vals) - SEG, STRIDE // 2):
        seg = vals[s : s + SEG]
        ctx = vals[s - CTX : s]
        t0, t1 = ts[s], ts[s + SEG - 1]
        y = int(any(t1 >= a and t0 <= b for a, b in centers))
        # skrót kontekstu: co 6. próbka (30 min) – mniejszy plik, wystarczy do cech
        (items if (s - CTX) % STRIDE == 0 else items2).append(
            {
                "seg": [round(v, 2) for v in seg[::2]],
                "ctx": [round(v, 2) for v in ctx[::6]],
                "t": t0.isoformat(),
                "y": y,
            }
        )
    pos = [x for x in items if x["y"]]
    neg = [x for x in items if not x["y"]]
    rng.shuffle(pos)
    rng.shuffle(neg)
    seed = pos[:2] + neg[:8]
    test = pos[20:] + neg[50:250]
    # Pula pytań (runda ≥ 2): okna przesunięte o pół kroku (nie ma ich w zestawie startowym ani testowym), wybór tajny.
    # Uczciwie: etykiety NAB są publiczne, a pytanie zawiera czas – odpowiedź da się sprawdzić w źródle.
    pos2 = [x for x in items2 if x["y"]]
    neg2 = [x for x in items2 if not x["y"]]
    grng.shuffle(pos2)
    grng.shuffle(neg2)
    pool = pos2[:18] + neg2[:42]
    grng.shuffle(pool)
    qs, gold = [], {}
    for i, x in enumerate(pool):
        qid = goldkit.rid("s", i, 4)
        qs.append({"id": qid, "seg": x["seg"], "ctx": x["ctx"], "t": x["t"]})
        gold[qid] = "tak" if x["y"] else "nie"
    strip = lambda xs: [{"seg": x["seg"], "ctx": x["ctx"], "y": x["y"]} for x in xs]  # noqa: E731
    return strip(seed), strip(test), qs, gold


def main() -> None:
    rng = random.Random(42)  # jawne: zestaw startowy i testowy (stałe od rundy 1)
    grng = random.Random(goldkit.seed("qa"))  # tajne: pula pytań kontrolnych
    i_seed, i_test, i_qs, i_gold = intents(rng, grng)
    s_seed, s_test, s_qs, s_gold = sensor(rng, grng)
    k_qs = [{"id": k, "pl": pl, "en": en} for k, pl, en, _ in KNOWLEDGE]
    out = {
        "version": 1,
        "intent": {
            "labels": INTENTS,
            "labels_pl": [INTENT_PL[k] for k in INTENTS],
            "seed": i_seed,
            "test": i_test,
            "questions": i_qs,
        },
        "sensor": {
            "source": "NAB realKnownCause/machine_temperature_system_failure",
            "seed": s_seed,
            "test": s_test,
            "questions": s_qs,
        },
        "knowledge": {"questions": k_qs},
    }
    dst = ROOT / "web" / "public" / "data" / "qa.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    gold = {**i_gold, **s_gold}
    goldkit.write("qa", gold, "scripts/export_qa_seed.py")
    print(
        f"qa.json {dst.stat().st_size // 1024} KB; pytania: {len(i_qs)} intencji, {len(s_qs)} czujnika, {len(k_qs)} wiedzy; gold {len(gold)}"
    )


if __name__ == "__main__":
    main()
