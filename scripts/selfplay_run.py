"""Samodzielne ćwiczenia (S2): bieżąca opublikowana wersja LM grzybni rozwiązuje polskie zadania logiczne.

Na boxie: generuje zadania (bez przecieku: hash + 8-gramy słów zbioru bramki odczytane z eval.bin), model odpowiada
zachłannie (temp 0), sprawdzarka liczy trafność per kategoria. Wynik: results/selfplay/<data>.json (prawdziwe liczby)
oraz poprawnie rozwiązane próbki (JSONL) jako kandydat na odłamek treningowy – do treningu wejdą osobnym krokiem
i tylko przez bramkę. Zbiór bramki nie jest zmieniany.

Program nauczania: poziom każdej kategorii z poprzedniego raportu (`--prev`, domyślnie najnowszy) przez
`selfplay.target_levels` – celujemy w 30–70% trafności. Raport ma per kategoria `baseline` („zawsze ta sama odpowiedź”)
i trafność per poziom.

`--human N` dodatkowo: pytania tylko dla ludzi (`selfplay.human_items`) z niepewnością modelu (rozkład prawdopodobieństwa
na odpowiedziach z logitów, margines = p1 − p2) oraz pytania kontrolne (zadania sprawdzalne, zrównoważone) →
`web/public/data/logic/queue.json` (bez odpowiedzi kontrolnych) i `.gold/logic.json` (odpowiedzi kontrolne – poza repo, do
`myc_gold` przez `scripts/gold_rotate.py`; pula kontrolna z tajnego `MYC_GOLD_SEED`, scripts/goldkit.py). Odpowiedzi ludzi trafiają do `myc_answers` (Ucz AI → „Oczekujące pytania”).

Użycie: MYC_CACHE=… PYTHONPATH=src python scripts/selfplay_run.py --n 160 --seed 1 [--human 60 --control 60]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from iot_mycelium.mesh import lm, selfplay  # noqa: E402
from iot_mycelium.mesh.net import SB_KEY, SB_URL  # noqa: E402
from iot_mycelium.mesh.qwen import Qwen, ensure_weights  # noqa: E402

sys.path.insert(0, str(ROOT / "scripts"))
import goldkit  # noqa: E402

TOK = "Qwen/Qwen2.5-0.5B-Instruct"
TOK_REV = "7ae557604adf67be50417f59c2c2f167def9a775"


def latest_lm():
    h = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}
    u = f"{SB_URL}/rest/v1/myc_models?model=eq.lm&order=version.desc&limit=1&select=version,path"
    row = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=60).read())[0]  # noqa: S310
    b = urllib.request.urlopen(f"{SB_URL}/storage/v1/object/public/myc-models/{row['path']}", timeout=120).read()  # noqa: S310
    assert row["path"].endswith(f"-{lm.sha256(b)[:8]}.bin")
    return row["version"], lm.Lora.from_bytes(b)


# kody odpowiedzi w myc_answers (^[a-z_]+$): rozstrzygnięcia i litery wyboru
TN_CODE = {"tak": "tak", "nie": "nie", "nie wiadomo": "nw"}
LETTERS = "abcdefgh"


def qid(sha: str) -> str:
    return "l" + sha[:8]


def options_for(t: selfplay.Task) -> list[tuple[str, str]] | None:
    """(kod, etykieta) odpowiedzi dla człowieka; None = zadanie nie nadaje się na pytanie kontrolne (np. liczba)."""
    if t.answer in TN_CODE and t.kind in selfplay.TERNARY:
        return [(TN_CODE[o], o) for o in ("tak", "nie", "nie wiadomo")]
    if t.options:
        return [(LETTERS[i], o) for i, o in enumerate(t.options)]
    if t.answer in selfplay.PEOPLE:
        names = sorted({n for n in selfplay.NAMES if re.search(rf"\b{n}\b", t.question)})
        return [(LETTERS[i], n) for i, n in enumerate(names)] if t.answer in names and len(names) >= 2 else None
    return None


def option_probs(m, tok, conv: str, question: str, labels: list[str]) -> list[float]:
    """Rozkład modelu na odpowiedziach: średni log-prob tokenów każdej etykiety po pytaniu, softmax po etykietach."""
    msgs = [{"role": "user", "content": question}]
    prompt = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=True)
    if not isinstance(prompt, list):
        prompt = list(prompt["input_ids"])
    scores = []
    for lab in labels:
        ids = tok.encode(lab, add_special_tokens=False)
        s, rest = m.session(conv, list(prompt))
        logits = m.forward(rest, s)
        lp = 0.0
        for t in ids:
            lp += float(F.log_softmax(logits, -1)[t])
            logits = m.forward([t], s)
        scores.append(lp / max(1, len(ids)))
    p = torch.softmax(torch.tensor(scores), 0).tolist()
    return [round(x, 4) for x in p]


def latest_report(out: Path) -> dict | None:
    reps = sorted(p for p in out.glob("2*.json") if re.fullmatch(r"\d{8}-\d{4}\.json", p.name))
    return json.loads(reps[-1].read_text()) if reps else None


def rozbior_tasks(n: int, seed: int, gate_hash: set, gate_ng: set) -> list[selfplay.Task]:
    """Zadania z ram zdań UD (tylko pliki train-*; test UD nigdy) + wnioskowanie z czasowników przekazania (Walenty)."""
    import gzip

    from iot_mycelium.rozbior import pytania, zbior

    sents = zbior.local("train-pdb")
    w = json.loads(gzip.decompress((zbior.DATA / "walenty.json.gz").read_bytes()))
    return pytania.sample(sents, n, seed, set(w["meta"].get("transfer", [])), exclude=gate_hash, gate_ngrams=gate_ng)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=160)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--out", default=str(ROOT / "results" / "selfplay"))
    ap.add_argument("--prev", default="", help="raport poprzedniego pomiaru (domyślnie najnowszy w --out)")
    ap.add_argument("--human", type=int, default=0, help="ile pytań tylko dla ludzi wyeksportować do Ucz AI")
    ap.add_argument("--control", type=int, default=0, help="ile pytań kontrolnych (sprawdzalnych) dołączyć")
    ap.add_argument("--rozbior", type=int, default=0, help="ile zadań z rozbioru zdań UD (train) dołożyć")
    ap.add_argument(
        "--queue-only",
        action="store_true",
        help="tylko kolejka Ucz AI (nowa pula kontrolna); trafność per kategoria z ostatniego raportu w --out",
    )
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(TOK, revision=TOK_REV)
    eb = (ROOT / "web" / "public" / "data" / "lm" / "eval.bin").read_bytes()
    em, ids, mask, extra = lm.unpack_data(eb)
    gate_texts = [tok.decode(r[m].tolist()) for r, m in zip(ids, mask, strict=True)]
    gate_ng = set().union(*(selfplay.ngrams(t, 8) for t in gate_texts))
    gate_hash = {selfplay.qhash(t) for t in gate_texts}
    out = Path(a.out)
    prev = json.loads(Path(a.prev).read_text()) if a.prev else latest_report(out)
    if a.queue_only:
        if not prev:
            raise SystemExit("--queue-only wymaga raportu w --out")
        version, lora = latest_lm()
        m = Qwen(ensure_weights(print), torch.bfloat16)
        m.lora = lm.runtime(lora, m.dtype)
        return export_queue(a, m, tok, version, gate_hash, gate_ng, prev)
    plan = selfplay.target_levels((prev or {}).get("per_level") or {})
    tasks = selfplay.generate(
        a.n, a.seed, exclude=gate_hash, gate_ngrams=gate_ng, levels=plan["levels"], weights=plan["weights"]
    )
    if a.rozbior:
        tasks += rozbior_tasks(a.rozbior, a.seed, gate_hash, gate_ng)
    version, lora = latest_lm()
    m = Qwen(ensure_weights(print), torch.bfloat16)
    m.lora = lm.runtime(lora, m.dtype)
    tally, good = selfplay.Tally(), []
    t0 = time.time()
    for i, t in enumerate(tasks):
        msgs = [{"role": "user", "content": t.question}]
        prompt = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=True)
        if not isinstance(prompt, list):
            prompt = list(prompt["input_ids"])
        r = m.generate(f"selfplay-{i}", list(prompt), max_new=24, temp=0.0)
        reply = tok.decode(r["tokens"], skip_special_tokens=True)
        ok = selfplay.check(t, reply)
        tally.add(t.kind, ok, t.answer, t.level)
        if ok:
            good.append({"kind": t.kind, "q": t.question, "a": reply.strip(), "answer": t.answer, "sha": t.sha})
    out.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M")
    total = sum(tally.seen.values())
    rep = {
        "model": f"lm v{version}",
        "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "seed": a.seed,
        "n": total,
        "correct": sum(tally.ok.values()),
        "acc": round(sum(tally.ok.values()) / max(1, total), 4),
        "per_category": tally.summary(),
        "per_level": tally.per_level(),
        "plan": {"levels": plan["levels"], "weights": plan["weights"], "from": (prev or {}).get("when")},
        "generator": "selfplay v2 (16 kategorii, tak/nie/nie wiadomo po równo, poziomy 1–3)",
        "gate_eval_sha": lm.sha256(eb),
        "gate_rows": len(gate_texts),
        "decoding": "greedy, max 24 tokens",
        "seconds": round(time.time() - t0),
    }
    (out / f"{stamp}.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1))
    (out / f"{stamp}-correct.jsonl").write_text("".join(json.dumps(g, ensure_ascii=False) + "\n" for g in good))
    print(json.dumps(rep, ensure_ascii=False))
    if a.human or a.control:
        export_queue(a, m, tok, version, gate_hash, gate_ng, rep)


def export_queue(a, m, tok, version, gate_hash, gate_ng, rep) -> None:
    """Kolejka Ucz AI: pytania tylko dla ludzi (najmniej pewne najpierw) + kontrolne; odpowiedzi kontrolne do SQL."""
    # Pula kontrolna z tajnego ziarna (goldkit); bez zadań, które już są jawne (poprawne odpowiedzi w results/selfplay)
    published = {json.loads(x)["sha"] for f in (ROOT / "results" / "selfplay").glob("*-correct.jsonl")
                 for x in f.read_text().splitlines() if x.strip()}  # fmt: skip
    n_pool = max(200, a.control * 4)
    r1 = {
        t.sha for t in selfplay.generate(n_pool, a.seed + 1000, exclude=gate_hash, gate_ngrams=gate_ng)
    }  # jawna runda 1
    prev_q = ROOT / "web" / "public" / "data" / "logic" / "queue.json"  # poprzednia (już publiczna) kolejka
    if prev_q.exists():
        r1 |= {selfplay.qhash(c["q"]) for c in json.loads(prev_q.read_text()).get("control", [])}
    pool = selfplay.generate(n_pool, goldkit.seed("logic"), exclude=gate_hash | published | r1, gate_ngrams=gate_ng)
    humans = []
    for i, h in enumerate(selfplay.human_items(a.human, a.seed, pool)):
        labels = list(h.options)
        p = option_probs(m, tok, f"h{i}", h.question, labels)
        top = sorted(p, reverse=True)
        codes = [TN_CODE.get(o, LETTERS[j]) for j, o in enumerate(h.options)]
        humans.append({
            "id": qid(h.sha), "kind": h.kind, "q": h.question, "why": h.why,
            "options": [{"v": c, "label": o} for c, o in zip(codes, h.options, strict=True)] + [{"v": "zle", "label": "pytanie jest złe"}],
            "model": {"p": dict(zip(codes, p, strict=True)), "margin": round(top[0] - top[1], 4)},
        })  # fmt: skip
    humans.sort(key=lambda x: (x["model"]["margin"], x["id"]))
    per = rep["per_category"]
    control, gold, seen = [], [], set()
    for t in pool:
        o = options_for(t)
        if not o or len(control) >= a.control or t.sha in seen:
            continue
        seen.add(t.sha)
        code = next(c for c, lab in o if lab == t.answer)
        control.append({"id": goldkit.hid("l", t.sha), "kind": t.kind, "level": t.level, "q": t.question, "options": [{"v": c, "label": lab} for c, lab in o],
                        "model_acc": per.get(t.kind, {}).get("acc"), "model_acc_from": rep.get("when")})  # fmt: skip
        gold.append((goldkit.hid("l", t.sha), code))
    q = {
        "generated_at": rep["when"],
        "model": rep["model"],
        "source": "scripts/selfplay_run.py (selfplay v2); niepewność = rozkład logitów modelu na odpowiedziach",
        "per_category": per,
        "human": humans,
        "control": control,
    }
    dst = ROOT / "web" / "public" / "data" / "logic"
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "queue.json").write_text(json.dumps(q, ensure_ascii=False, indent=0))
    goldkit.write("logic", gold, "scripts/selfplay_run.py")
    print(f"kolejka: {len(humans)} dla ludzi, {len(control)} kontrolnych → {dst / 'queue.json'}")


if __name__ == "__main__":
    main()
