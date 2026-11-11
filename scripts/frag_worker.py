"""Węzeł „strzępków”: wyciąga atomowe fakty z prawdziwych danych, łączy je w pojęcia i tematy
i dosyła do wspólnej bazy (RPC ``myc_frag_add``, klucz publikowalny + limiter jak każdy węzeł).

Źródła: słowniki (WordNet/plWordNet z ``web/public/data``), pary PL↔EN, odpowiedzi węzłów
rozstrzygnięte konsensusem (Dawid-Skene) i decyzje właściciela z zakładki Weryfikuj.
Słownik dochodzi porcjami (``--words`` na cykl), więc wzrost warstw widać w czasie.

    python scripts/frag_worker.py --loop 600
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from iot_mycelium.ai import fragments as fr  # noqa: E402
from iot_mycelium.ai.consensus import Answer, infer  # noqa: E402

URL = "https://agortpieeygmcttjwjfx.supabase.co/rest/v1"
KEY = "sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P"  # publiczny z założenia (RLS)
DATA = ROOT / "web" / "public" / "data"
YN = ["tak", "nie"]


def req(method: str, path: str, body=None, tries: int = 4):
    """REST z ponowieniem przy zerwanym połączeniu (zapisy są idempotentne – klucze strzępków)."""
    data = json.dumps(body).encode() if body is not None else None
    h = {"apikey": KEY, "Content-Type": "application/json", "User-Agent": "mycelium-frag/1"}
    for i in range(tries):
        r = urllib.request.Request(URL + path, data=data, method=method, headers=h)  # noqa: S310
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:  # noqa: S310
                t = resp.read().decode()
                return json.loads(t) if t else None
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))
    return None


def page(path: str, n: int = 1000, cap: int = 60000) -> list[dict]:
    out: list[dict] = []
    while len(out) < cap:
        rows = req("GET", f"{path}&limit={n}&offset={len(out)}")
        out += rows
        if len(rows) < n:
            break
    return out


def truths(lex: dict, cap: dict, qa: dict) -> tuple[dict[str, tuple[str, float]], list[dict]]:
    answers = page("/myc_answers?select=question_id,node_id,answer,owner&order=id")
    uqs = page("/myc_user_questions?select=id,kind,text,answer&order=created_at")
    gold = {r["node_id"]: (r["n"], r["correct"]) for r in req("POST", "/rpc/myc_gold_stats", {})}
    labels = req("POST", "/rpc/myc_review_labels", {"p_room": "main"})
    opts: dict[str, list[str]] = {q["id"]: qa["intent"]["labels"] for q in qa["intent"]["questions"]}
    opts |= {q["id"]: YN for q in qa["knowledge"]["questions"]}
    for q in lex["questions"]:
        for j in range(len(lex["taxonomy"])):
            opts[f"{q['id']}c{j:03d}"] = YN
    opts |= {p["id"]: YN for p in cap["pairs"]}
    for q in cap["fashion"]["pool"]:
        for k in range(10):
            opts[f"{q['id']}k{k}"] = YN
    cats = [c["id"] for c in lex["taxonomy"]]
    for u in uqs:
        opts[u["id"]] = qa["intent"]["labels"] if u["kind"] == "example" else cats if u["kind"] == "word" else YN
    cons = infer(
        [Answer(a["question_id"], a["node_id"], a["answer"], bool(a.get("owner"))) for a in answers], opts, gold
    )
    t = {q: cons.truth(q) for q in cons.posterior}
    for lb in labels:  # decyzja właściciela/zaufanego współtwórcy nadpisuje konsensus
        if lb["item_type"] in ("answer", "word", "captcha", "teach") and lb["truth"]:
            t[lb["item_ref"]] = (lb["truth"], float(lb["weight"]))
    return t, uqs


def cycle(state: dict, words_per_cycle: int, dry: bool = False) -> dict:
    lex = json.loads((DATA / "lexicon.json").read_text())
    cap = json.loads((DATA / "captcha.json").read_text())
    qa = json.loads((DATA / "qa.json").read_text())
    upto = min(len(lex["words"]), state.get("words", 0) + words_per_cycle)
    frags = fr.from_lexicon(lex, 0, upto) + fr.from_pairs(cap["pairs"])
    t, uqs = truths(lex, cap, qa)
    pairs = {p["id"]: p for p in cap["pairs"]}
    frags += fr.from_consensus(t, qa, lex, pairs, cap["fashion"]["classes_pl"], uqs)
    g = fr.build(frags, lex)
    sent: set[str] = set(state.get("sent", []))
    new_f = {k: f for k, f in g.frags.items() if k not in sent}
    new_l = {k: lk for k, lk in g.links.items() if "|".join(k) not in sent}
    sub = fr.Graph(new_f, new_l)
    tot = {"frags": 0, "links": 0, "conflicts": 0}
    for fb, lb in fr.batches(sub):
        if dry:
            continue
        for attempt in range(5):
            try:
                r = req("POST", "/rpc/myc_frag_add", {"p_node": state["node"], "p_frags": fb, "p_links": lb})
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 4:
                    raise
                time.sleep(20)
        for k in tot:
            tot[k] += int(r.get(k, 0))
        time.sleep(1.6)  # limiter 40/min na węzeł
    if not dry:
        sent |= set(new_f) | {"|".join(k) for k in new_l}
        state["sent"] = sorted(sent)
        state["words"] = upto
    out = {
        "layers": g.layer_counts(),
        "new": tot,
        "sent_frags": len(new_f),
        "sent_links": len(new_l),
        "words": upto,
        "consensus_frags": sum(1 for f in frags if f.source in ("consensus", "captcha", "teach")),
    }
    if not dry and (tot["frags"] or tot["links"]):
        with contextlib.suppress(urllib.error.HTTPError):
            req(
                "POST",
                "/myc_growth",
                {
                    "node_id": state["node"],
                    "kind": "python",
                    "agent": "strzępki",
                    "event": "action",
                    "detail": {
                        "what": "fragments",
                        "frags": tot["frags"],
                        "links": tot["links"],
                        "conflicts": tot["conflicts"],
                        "layers": {str(k): v for k, v in out["layers"].items()},
                    },
                },
            )
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default=str(Path.home() / ".mycelium" / "frag_worker.json"))
    ap.add_argument("--words", type=int, default=800, help="ile słów słownika dołożyć na cykl")
    ap.add_argument("--loop", type=int, default=0, help="co ile sekund powtarzać (0 = raz)")
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args(argv)
    p = Path(a.state)
    p.parent.mkdir(parents=True, exist_ok=True)
    state = json.loads(p.read_text()) if p.exists() else {}
    state.setdefault("node", str(uuid.uuid4()))
    while True:
        try:
            out = cycle(state, a.words, a.dry)
            print(time.strftime("%F %T"), json.dumps(out), flush=True)
            if not a.dry:
                p.write_text(json.dumps(state))
        except Exception as e:  # noqa: BLE001 – węzeł ma przetrwać chwilową awarię sieci
            print(time.strftime("%F %T"), "błąd:", repr(e), flush=True)
        if not a.loop:
            break
        time.sleep(a.loop)


if __name__ == "__main__":
    main()
