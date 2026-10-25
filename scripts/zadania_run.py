"""Zadania wielokierunkowe (Ucz AI → podział na typy): matematyczne, analityczne, wzrokowe.

Na boxie: generuje zadania sprawdzane programem (bez przecieku do bramki LM: hash + 8-gramy słów zbioru bramki
odczytane z ``web/public/data/lm/eval.bin``), mierzy bieżącą opublikowaną wersję LM grzybni na zadaniach
matematycznych i analitycznych (wybór 1 z 4: rozkład log-prob na odpowiedziach) i model obrazów (regresja softmax
196→10 na 200 obrazach startowych z ``captcha.json`` – ten sam co „tylko start” w przeglądarce) na zadaniach wzrokowych.

Wyjście:
* ``web/public/data/zadania/queue.json`` – zadania BEZ odpowiedzi + wyniki modeli per typ i rodzaj,
* ``.gold/zadania.json`` – poprawne odpowiedzi (poza repo) → ``myc_gold`` przez ``scripts/gold_rotate.py`` (niewidoczne
  dla przeglądarki); pula z tajnego ``MYC_GOLD_SEED`` (scripts/goldkit.py),
* ``results/zadania/<data>.json`` – raport, ``<data>-sft.jsonl`` – zadania z poprawną odpowiedzią programu
  (kandydat na odłamek SFT; do treningu LM tylko osobnym krokiem i przez bramkę 2000 pytań).

Zadania wzrokowe: obrazy z oficjalnego testu Fashion-MNIST (t10k), których NIE ma w żadnym publicznym pliku
z etykietami (odłamki ``data/ml/fashion`` val/test, ``captcha.json`` test/pula/obroty) – etykieta jest tylko w myc_gold.

Użycie: PYTHONPATH=src /workspace/.venv-kd/bin/python scripts/zadania_run.py --per-kind 24 --images 100
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
import goldkit  # noqa: E402

from iot_mycelium.mesh import lm, selfplay, zadania  # noqa: E402

DS = Path.home() / ".cache" / "iot-mycelium" / "datasets"
VLET = "abcdefghij"


def idx(path: Path, off: int) -> np.ndarray:
    return np.frombuffer(gzip.decompress(path.read_bytes()), np.uint8, offset=off)


def pool14(x: np.ndarray) -> np.ndarray:
    x = x.reshape(-1, 28, 28).astype(np.float64)
    return np.round((x[:, 0::2, 0::2] + x[:, 0::2, 1::2] + x[:, 1::2, 0::2] + x[:, 1::2, 1::2]) / 4).reshape(-1, 196)


def fit_softmax(X: np.ndarray, y: np.ndarray, k: int, epochs=60, lr=0.5, l2=1e-3):
    """Jak PixelAgent.fit w web/src/myc/vision.ts (pełny gradient, L2)."""
    W, b = np.zeros((k, X.shape[1])), np.zeros(k)
    Y = np.eye(k)[y]
    for _ in range(epochs):
        z = X @ W.T + b
        p = np.exp(z - z.max(1, keepdims=True))
        p /= p.sum(1, keepdims=True)
        g = p - Y
        W -= lr * (g.T @ X / len(X) + l2 * W)
        b -= lr * g.mean(0)
    return W, b


def visual(n_img: int, seed: int) -> tuple[list[dict], list[tuple[str, str]], dict]:
    import random

    from export_captcha import fashion_spare

    tx = idx(DS / "t10k-images-idx3-ubyte.gz", 16).reshape(-1, 784)
    ty = idx(DS / "t10k-labels-idx1-ubyte.gz", 8)
    fy = idx(DS / "train-labels-idx1-ubyte.gz", 8)
    cap = json.loads((ROOT / "web" / "public" / "data" / "captcha.json").read_text())
    nrng = np.random.default_rng(11)
    for c in range(10):
        nrng.choice(np.where(fy == c)[0], 20, replace=False)
    perm = nrng.permutation(len(tx))
    assert ty[perm[:500]].tolist() == cap["fashion"]["test"]["y"], "niezgodna rekonstrukcja captcha.json"
    rng = np.random.default_rng(2026)
    rng.permutation(60000)
    q = rng.permutation(len(tx))
    test_bin = (ROOT / "web" / "public" / "data" / "ml" / "fashion" / "test.bin").read_bytes()
    assert np.frombuffer(test_bin[:785], np.uint8)[:784].tobytes() == tx[q[1000]].tobytes(), (
        "niezgodna rekonstrukcja test.bin"
    )
    # wolne obrazy = spoza testów, odłamków, jawnych pul rundy 1 (captcha i v…) i tajnej puli captcha bieżącej rundy
    spare = fashion_spare(perm)
    cap_rng = random.Random(goldkit.seed("captcha"))
    cap_spare = list(spare)
    cap_rng.shuffle(cap_spare)
    cap_used = set(cap_spare[:480])
    pool_px = {base64.b64decode(x["px"]) for x in cap["fashion"]["pool"]}
    assert all(tx[i].tobytes() in pool_px for i in cap_spare[:5]), "niezgodna rekonstrukcja puli captcha"
    ok = set(spare) - cap_used
    free = [i for i in np.random.default_rng(seed).permutation(len(tx)).tolist() if i in ok]
    per = n_img // 10
    pick = [i for c in range(10) for i in [j for j in free if ty[j] == c][:per]]
    np.random.default_rng(seed + 1).shuffle(pick)
    # model startowy: te same 200 obrazów z etykietami co w przeglądarce
    sx = np.frombuffer(base64.b64decode(cap["fashion"]["seed"]["px"]), np.uint8).reshape(-1, 196) / 255
    W, b = fit_softmax(sx, np.array(cap["fashion"]["seed"]["y"]), 10)
    Xp = pool14(tx[pick]) / 255
    z = Xp @ W.T + b
    p = np.exp(z - z.max(1, keepdims=True))
    p /= p.sum(1, keepdims=True)
    pred = p.argmax(1)
    names = cap["fashion"]["classes_pl"]
    items, gold = [], []
    for k, i in enumerate(pick):
        px = tx[i].tobytes()
        qid = goldkit.hid("v", hashlib.sha256(px).hexdigest())
        items.append({
            "id": qid, "type": "wzrokowe", "kind": "Fashion-MNIST", "level": 1, "q": "Co jest na obrazku?",
            "px": base64.b64encode(px).decode(), "options": [{"v": VLET[c], "label": names[c]} for c in range(10)] + [{"v": "zle", "label": "nie da się rozpoznać"}],
            "model": {"pmax": round(float(p[k].max()), 4)},
        })  # fmt: skip
        gold.append((qid, VLET[int(ty[i])]))
    correct = int((pred == ty[pick]).sum())
    counts = np.bincount(ty[pick], minlength=10)
    rep = {
        "name": "model obrazów – regresja softmax 196→10, tylko 200 obrazów startowych (captcha.json)",
        "n": len(pick), "correct": correct, "acc": round(correct / max(1, len(pick)), 4),
        "baseline": round(float(counts.max() / max(1, len(pick))), 4),
        "source": "Fashion-MNIST t10k (Zalando, MIT), obrazy spoza publicznych plików z etykietami",
    }  # fmt: skip
    return items, gold, rep


def lm_eval(items: list[zadania.Item], threads: int) -> tuple[str, list[list[float]]]:
    from selfplay_run import TOK, TOK_REV, latest_lm, option_probs
    from transformers import AutoTokenizer

    from iot_mycelium.mesh.qwen import Qwen, ensure_weights

    torch.set_num_threads(threads)
    tok = AutoTokenizer.from_pretrained(TOK, revision=TOK_REV)
    version, lora = latest_lm()
    m = Qwen(ensure_weights(print), torch.bfloat16)
    m.lora = lm.runtime(lora, m.dtype)
    out = []
    for i, it in enumerate(items):
        prompt = it.q + "\nOdpowiedzi: " + "; ".join(it.options) + ".\nPodaj jedną odpowiedź."
        out.append(option_probs(m, tok, f"z{i}", prompt, list(it.options)))
    return f"lm v{version}", out


def gate():
    from selfplay_run import TOK, TOK_REV
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(TOK, revision=TOK_REV)
    eb = (ROOT / "web" / "public" / "data" / "lm" / "eval.bin").read_bytes()
    _em, ids, mask, _x = lm.unpack_data(eb)
    texts = [tok.decode(r[m_].tolist()) for r, m_ in zip(ids, mask, strict=True)]
    return (
        {selfplay.qhash(t) for t in texts},
        set().union(*(selfplay.ngrams(t, 8) for t in texts)),
        lm.sha256(eb),
        len(texts),
    )


def summary(rows: list[tuple[str, int, bool, int]]) -> dict:
    """rows: (rodzaj, poziom, czy model trafił, indeks poprawnej odpowiedzi)."""

    def agg(rs):
        n = len(rs)
        c = sum(1 for r in rs if r[2])
        lets = [r[3] for r in rs]
        base = max(lets.count(j) for j in range(4)) / n if n else 0
        return {"n": n, "correct": c, "acc": round(c / n, 4) if n else None, "baseline": round(base, 4)}

    out = agg(rows)
    out["per_kind"] = {k: agg([r for r in rows if r[0] == k]) for k in sorted({r[0] for r in rows})}
    out["per_level"] = {str(lv): agg([r for r in rows if r[1] == lv]) for lv in (1, 2, 3)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-kind", type=int, default=24)
    ap.add_argument("--images", type=int, default=100)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument(
        "--no-lm", action="store_true", help="bez pomiaru LM (baza niedostępna) – wynik modelu: brak pomiaru"
    )
    a = ap.parse_args()
    t0 = time.time()
    gh, gng, gsha, grows = gate()
    facts: dict[str, list[dict]] = {}
    for f in json.loads((ROOT / "web" / "public" / "data" / "seed" / "facts.json").read_text())["facts"]:
        facts.setdefault(f["rel"], []).append(f)
    gseed = goldkit.seed("zadania")
    r1 = {it.sha for it in zadania.generate(a.per_kind, 1, facts, exclude=gh, gate_ngrams=gng)}  # jawna runda 1
    prev_q = ROOT / "web" / "public" / "data" / "zadania" / "queue.json"  # poprzednia (już publiczna) pula
    if prev_q.exists():
        r1 |= {selfplay.qhash(x["q"]) for x in json.loads(prev_q.read_text())["items"] if x["id"][0] in "ma"}
    items = zadania.generate(a.per_kind, gseed, facts, exclude=gh | r1, gate_ngrams=gng)
    vitems, vgold, vrep = visual(a.images, gseed % 2**32)
    model, probs = ("", [None] * len(items)) if a.no_lm else lm_eval(items, a.threads)
    rows = {"matematyczne": [], "analityczne": []}
    out_items, gold, sft = [], [], []
    acc_kind: dict[str, list[bool]] = {}
    for it, p in zip(items, probs, strict=True):
        ok = None if p is None else int(np.argmax(p)) == it.answer
        rows[it.type].append((it.kind, it.level, ok, it.answer))
        acc_kind.setdefault(it.kind, []).append(ok)
        qid = goldkit.hid("m" if it.type == "matematyczne" else "a", it.sha)
        top = sorted(p or [0, 0], reverse=True)
        out_items.append({
            "id": qid, "type": it.type, "kind": it.kind, "level": it.level, "q": it.q,
            "options": [{"v": zadania.LETTERS[j], "label": o} for j, o in enumerate(it.options)] + [{"v": "zle", "label": "pytanie jest złe"}],
            **({} if p is None else {"model": {"margin": round(top[0] - top[1], 4)}}), "sources": list(it.sources),
        })  # fmt: skip
        gold.append((qid, it.code))
        sft.append({"id": qid, "type": it.type, "kind": it.kind, "level": it.level, "q": it.q, "options": list(it.options),
                    "answer": it.options[it.answer], "model_ok": ok})  # fmt: skip
    for o in out_items:
        ks = acc_kind[o["kind"]]
        if None not in ks:
            o["model_acc"] = round(sum(ks) / len(ks), 4)
    ids = [o["id"] for o in out_items + vitems]
    assert len(ids) == len(set(ids)), "kolizja identyfikatorów"
    when = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    lmm = (lambda t: None) if a.no_lm else (lambda t: {"name": model, **summary(rows[t])})
    types = {
        "matematyczne": {"n": len(rows["matematyczne"]), "model": lmm("matematyczne")},
        "analityczne": {"n": len(rows["analityczne"]), "model": lmm("analityczne")},
        "wzrokowe": {"n": len(vitems), "model": vrep},
    }
    q = {
        "generated_at": when,
        "source": "scripts/zadania_run.py; odpowiedzi tylko w myc_gold; LM: wybór 1 z 4 (log-prob odpowiedzi)",
        "gate": {
            "file": "web/public/data/lm/eval.bin",
            "sha256": gsha,
            "rows": grows,
            "rule": "sha256(norm(tekst)) albo wspólny 8-gram",
        },
        "types": types,
        "items": out_items + vitems,
    }
    dst = ROOT / "web" / "public" / "data" / "zadania"
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "queue.json").write_text(json.dumps(q, ensure_ascii=False, separators=(",", ":")))
    goldkit.write("zadania", gold + vgold, "scripts/zadania_run.py")
    res = ROOT / "results" / "zadania"
    res.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M")
    rep = {
        "when": when,
        "seed": "tajne (MYC_GOLD_SEED)",
        "round": goldkit.ROUND,
        "types": types,
        "gate_eval_sha": gsha,
        "seconds": round(time.time() - t0),
    }
    (res / f"{stamp}.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1))
    # SFT zawiera poprawne odpowiedzi – tylko poza repo (.gold/), nigdy w results/
    (goldkit.GOLD_DIR / f"zadania-sft-{stamp}.jsonl").write_text(
        "".join(json.dumps(s, ensure_ascii=False) + "\n" for s in sft)
    )
    print(json.dumps(rep, ensure_ascii=False))


if __name__ == "__main__":
    main()
