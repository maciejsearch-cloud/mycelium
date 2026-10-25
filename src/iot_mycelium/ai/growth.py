"""Autonomiczna pętla wzrostu grzybni („motywacja wewnętrzna”).

Jeden cykl (``run_once``):

1. **Cele** – mierzy: IQ grzybni, liczbę poznanych faktów, trafność na pytaniach
   kontrolnych, liczbę węzłów, wyniki nisz (intencje, czujnik, wiedza).
2. **Ciekawość** – wybiera niszę o największym oczekiwanym zysku
   (brakujący wynik + niepewność + świeże etykiety z konsensusu).
3. **Własne zadania** – generuje kandydatów zmian: hiperparametry, cechy, nowe
   etykiety z konsensusu, *narodziny* specjalisty dla najsłabszej klasy, *przycinanie*
   bezużytecznych specjalistów; w niszy wiedzy – nowe pytania do węzłów.
4. **Samoocena bez regresji** – zmiana przechodzi tylko, gdy poprawia wynik na zbiorze
   walidacyjnym i nie pogarsza wyniku na osobnym zbiorze kontrolnym.
5. **Dziennik** – wszystko trafia do ``myc_growth`` (oś „Wzrost” w UI). Najlepsza
   konfiguracja żyje w dzienniku, więc kolejne węzły (przeglądarki, Pi, cron) startują
   od dorobku poprzedników.

Bezpieczeństwo: żadnych działań poza własnymi tabelami; limiter w bazie.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import random
from pathlib import Path
from typing import Any

import numpy as np

from iot_mycelium.ai.consensus import Consensus, infer
from iot_mycelium.ai.learners import DEFAULT_CONFIG, YN, IntentAgent, SensorAgent, balanced_acc
from iot_mycelium.ai.node import Store

QA_PATH = Path(__file__).resolve().parents[3] / "web" / "public" / "data" / "qa.json"
FACT_CONF = 0.8


def load_qa(path: Path = QA_PATH) -> dict[str, Any]:
    return json.loads(path.read_text())


def options(qa: dict[str, Any]) -> dict[str, list[str]]:
    o = {q["id"]: qa["intent"]["labels"] for q in qa["intent"]["questions"]}
    o.update({q["id"]: YN for q in qa["sensor"]["questions"]})
    o.update({q["id"]: YN for q in qa["knowledge"]["questions"]})
    return o


def iq_from(scores: dict[str, float]) -> float:
    """Własny wskaźnik (MBS/IQ grzybni): 40 + 120 × średni wynik nisz. 100 ≈ wynik 0.5."""
    return round(40 + 120 * float(np.mean(list(scores.values()))), 1)


def _labelled(qa: dict, cons: Consensus, niche: str, min_conf: float) -> list[tuple[Any, int]]:
    out = []
    for q in qa[niche]["questions"]:
        if q["id"] in cons.posterior:
            lab, p = cons.truth(q["id"])
            if p >= min_conf:
                y = qa["intent"]["labels"].index(lab) if niche == "intent" else int(lab == "tak")
                out.append((q["text"] if niche == "intent" else q, y))
    return out


def evaluate(qa: dict, cons: Consensus, cfg: dict) -> dict[str, Any]:
    """Trenuje nisze wg ``cfg`` i zwraca wyniki val/test + agentów (do zadawania pytań)."""
    it = qa["intent"]
    extra = _labelled(qa, cons, "intent", cfg["intent"]["min_conf"])
    texts = [t for t, _ in it["seed"]] + [t for t, _ in extra]
    ys = [y for _, y in it["seed"]] + [y for _, y in extra]
    ia = IntentAgent(cfg["intent"], it["labels"]).fit(texts, ys)
    tt = [t for t, _ in it["test"]]
    ty = np.array([y for _, y in it["test"]])
    pred = ia.proba(tt).argmax(1)
    hit = pred == ty
    per_class = [float(hit[ty == c].mean()) for c in range(len(it["labels"]))]

    se = qa["sensor"]
    extra_s = _labelled(qa, cons, "sensor", cfg["sensor"]["min_conf"])
    items = se["seed"] + [q for q, _ in extra_s]
    sy = [x["y"] for x in se["seed"]] + [y for _, y in extra_s]
    sa = SensorAgent(cfg["sensor"]).fit(items, sy)
    sty = np.array([x["y"] for x in se["test"]])
    sp = (sa.proba(se["test"]) >= cfg["sensor"]["threshold"]).astype(int)

    kq = qa["knowledge"]["questions"]
    known = [cons.truth(q["id"])[1] for q in kq if q["id"] in cons.posterior]
    k_score = sum(p for p in known if p >= FACT_CONF) / len(kq)
    return {
        "intent_val": float(hit[0::2].mean()),
        "intent_test": float(hit[1::2].mean()),
        "sensor_val": balanced_acc(sty[0::2], sp[0::2]),
        "sensor_test": balanced_acc(sty[1::2], sp[1::2]),
        "knowledge": k_score,
        "per_class": per_class,
        "n_labels": {"intent": len(extra), "sensor": len(extra_s)},
        "agents": (ia, sa),
    }


def metrics(qa: dict, cons: Consensus, ev: dict, gold: dict[str, tuple[int, int]]) -> dict[str, Any]:
    scores = {
        "intent": (ev["intent_val"] + ev["intent_test"]) / 2,
        "sensor": (ev["sensor_val"] + ev["sensor_test"]) / 2,
        "knowledge": ev["knowledge"],
    }
    facts = sum(1 for q in cons.posterior if cons.truth(q)[1] >= FACT_CONF)
    g_n = sum(n for n, _ in gold.values())
    g_c = sum(c for _, c in gold.values())
    conf = float(np.mean([cons.truth(q)[1] for q in cons.posterior])) if cons.posterior else 0.0
    return {
        "iq": iq_from(scores),
        "scores": {k: round(v, 4) for k, v in scores.items()},
        "facts": facts,
        "gold_acc": round(g_c / g_n, 4) if g_n else None,
        "nodes": len(cons.answers_per_node),
        "consensus_conf": round(conf, 4),
    }


def curiosity(qa: dict, cons: Consensus, ev: dict, scores: dict[str, float]) -> dict[str, float]:
    """Oczekiwany zysk niszy: luka do ideału + niepewność + nowe etykiety."""
    ia, sa = ev["agents"]
    ip = ia.proba([q["text"] for q in qa["intent"]["questions"]])
    ent = float((-(ip * np.log(ip + 1e-12)).sum(1) / math.log(ip.shape[1])).mean())
    sp = sa.proba(qa["sensor"]["questions"])
    s_unc = float((1 - np.abs(sp - 0.5) * 2).mean())
    kq = qa["knowledge"]["questions"]
    k_unc = float(np.mean([1 - cons.truth(q["id"])[1] if q["id"] in cons.posterior else 1.0 for q in kq]))
    return {
        "intent": (1 - scores["intent"]) + 0.5 * ent + 0.02 * ev["n_labels"]["intent"],
        "sensor": (1 - scores["sensor"]) + 0.5 * s_unc + 0.02 * ev["n_labels"]["sensor"],
        "knowledge": (1 - scores["knowledge"]) * 0.8 + 0.3 * k_unc,
    }


def candidates(niche: str, cfg: dict, ev: dict, rng: random.Random, n: int = 6) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    c = cfg[niche]
    if niche == "intent":
        worst = int(np.argmin(ev["per_class"]))
        if worst not in c["specialists"] and len(c["specialists"]) < 4:
            new = copy.deepcopy(cfg)
            new["intent"]["specialists"] = [*c["specialists"], worst]
            out.append((f"spawn:intent:{worst}", new))
        for s in c["specialists"]:
            new = copy.deepcopy(cfg)
            new["intent"]["specialists"] = [x for x in c["specialists"] if x != s]
            out.append((f"prune:intent:{s}", new))
    knobs = {
        "intent": {
            "lr": [0.02, 0.05, 0.1, 0.2],
            "l2": [1e-4, 1e-3, 1e-2],
            "epochs": [80, 150, 300],
            "dim": [256, 512, 1024],
            "bigrams": [True, False],
            "min_conf": [0.6, 0.7, 0.85],
        },
        "sensor": {
            "lr": [0.02, 0.05, 0.1],
            "l2": [1e-4, 1e-3, 1e-2],
            "epochs": [100, 200, 400],
            "pos_weight": [1.0, 3.0, 6.0, 10.0],
            "threshold": [0.3, 0.4, 0.5, 0.6],
            "min_conf": [0.6, 0.7, 0.85],
        },
    }[niche]
    while len(out) < n:
        k = rng.choice(sorted(knobs))
        v = rng.choice([x for x in knobs[k] if x != c[k]])
        new = copy.deepcopy(cfg)
        new[niche][k] = v
        out.append((f"tune:{niche}:{k}={v}", new))
    return out


def latest_config(growth: list[dict]) -> dict:
    for g in growth:  # najnowsze pierwsze
        cfg = (g.get("detail") or {}).get("config")
        if (
            g.get("event") in ("accept", "spawn", "prune")
            and isinstance(cfg, dict)
            and {"intent", "sensor"} <= cfg.keys()
        ):
            merged = copy.deepcopy(DEFAULT_CONFIG)
            for niche in merged:
                merged[niche].update({k: v for k, v in cfg[niche].items() if k in merged[niche]})
            return merged
    return copy.deepcopy(DEFAULT_CONFIG)


def _key(niche: str, ev: dict, part: str) -> float:
    return ev[f"{niche}_{part}"]


def run_once(store: Store, qa: dict | None = None, seed: int | None = None, max_answers: int = 5) -> dict[str, Any]:
    qa = qa or load_qa()
    rng = random.Random(seed)
    store.flush()
    opts = options(qa)
    answers = store.answers()
    gold = store.gold_stats()
    cons = infer(answers, opts, gold)
    cfg = latest_config(store.growth())
    base = evaluate(qa, cons, cfg)
    m = metrics(qa, cons, base, gold)
    store.log("goal", {k: v for k, v in m.items() if k != "iq"}, iq=m["iq"])

    gains = curiosity(qa, cons, base, m["scores"])
    niche = max(gains, key=gains.__getitem__)
    store.log("action", {"niche": niche, "gains": {k: round(v, 3) for k, v in gains.items()}}, iq=m["iq"])
    result: dict[str, Any] = {"metrics": m, "niche": niche, "accepted": None}

    if niche == "knowledge" or gains["knowledge"] >= max(gains["intent"], gains["sensor"]):
        kq = qa["knowledge"]["questions"]
        unc = sorted(kq, key=lambda q: cons.truth(q["id"])[1] if q["id"] in cons.posterior else 0.0)[:3]
        store.log("question", {"niche": "knowledge", "ask": [q["id"] for q in unc]}, iq=m["iq"])
        result["asked"] = [q["id"] for q in unc]
    # Model uczy się zawsze: nisza modelowa o największym zysku (ciekawość).
    mniche = max(("intent", "sensor"), key=gains.__getitem__)
    result["model_niche"] = mniche
    best: tuple[float, str, dict, dict] | None = None
    for name, cand in candidates(mniche, cfg, base, rng):
        ev = evaluate(qa, cons, cand)
        gain = _key(mniche, ev, "val") - _key(mniche, base, "val")
        if best is None or gain > best[0]:
            best = (gain, name, cand, ev)
    assert best is not None
    gain, name, cand, ev = best
    no_regress = _key(mniche, ev, "test") >= _key(mniche, base, "test") - 0.01
    if gain > 0.004 and no_regress:
        new_m = metrics(qa, cons, ev, gold)
        event = name.split(":")[0] if name.startswith(("spawn", "prune")) else "accept"
        store.log(event, {"change": name, "val_gain": round(gain, 4), "config": cand}, iq=new_m["iq"])
        result.update(accepted=name, metrics=new_m)
        base = ev
    else:
        store.log("reject", {"change": name, "val_gain": round(gain, 4), "regress": not no_regress}, iq=m["iq"])
        result["rejected"] = name

    # Węzeł Python też odpowiada – tylko na pytania z czujnika i tylko pewne (≥ 0.9).
    if max_answers:
        _, sa = base["agents"]
        mine = {a.question_id for a in answers if a.node_id == store.node_id}
        sq = [q for q in qa["sensor"]["questions"] if q["id"] not in mine]
        if sq:
            p = sa.proba(sq)
            conf = np.maximum(p, 1 - p)
            for i in np.argsort(-conf)[:max_answers]:
                if conf[i] >= 0.9:
                    store.answer(sq[i]["id"], "tak" if p[i] >= 0.5 else "nie")
    store.stats(
        {
            "intent": round(base["intent_test"], 4),
            "sensor": round(base["sensor_test"], 4),
            "iq": result["metrics"]["iq"],
        },
        len(answers),
        label="python-cron",
    )
    store.save()
    return result


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Autonomiczny cykl wzrostu grzybni")
    ap.add_argument("--cycles", type=int, default=1)
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--no-answers", action="store_true")
    a = ap.parse_args(argv)
    store = Store(offline=a.offline or None)
    for _ in range(a.cycles):
        r = run_once(store, max_answers=0 if a.no_answers else 5)
        print(json.dumps({k: v for k, v in r.items()}, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
