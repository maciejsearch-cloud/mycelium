"""Odłamek SFT z konsensusu ludzi pod wpisami mówcy „Grzybnia AI” (czat globalny, supabase/myc_speaker.sql).

Wejście: publiczna tabela myc_speaker_sft – tylko pozycje z konsensusem (≥ 2 różne osoby z włączoną nauką podały tę
samą poprawkę / szyk / odpowiedź i to ≥ 2/3 zgłoszeń). Trzy rodzaje przykładów:
  poprawka  „Popraw zdanie: <wpis AI>” → poprawione zdanie,
  szyk      „Ułóż słowa w poprawnej kolejności: <wpis AI>” → ułożone słowa,
  odpowiedź <pytanie AI> → odpowiedź ludzi.
Gdy pozycji jest mniej niż --min (domyślnie 50), odłamek NIE powstaje (uczciwie: za mało danych), skrypt tylko to wypisuje.
Kontrola przecieku względem stałego zbioru bramki jak w export_selfplay_shard.py (hash + 8-gramy słów).

Użycie: python scripts/export_speaker_shard.py --tokenizer <tokenizer.json> [--name sft-speaker-0001.bin.gz] [--min 50]
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

DATA = ROOT / "web" / "public" / "data" / "lm"
SB_URL = "https://agortpieeygmcttjwjfx.supabase.co"
SB_KEY = "sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P"  # klucz publiczny (ten sam co w web/src/myc/store.ts)
PROMPT = {
    "poprawka": "Popraw zdanie: {p}",
    "szyk": "Ułóż słowa w poprawnej kolejności: {p}",
    "odpowiedź": "{p}",
}


def fetch() -> list[dict]:
    url = (
        f"{SB_URL}/rest/v1/myc_speaker_sft?select=level,kind,prompt,target,category,task_type,n_agree,n_total&order=id"
    )
    req = urllib.request.Request(url, headers={"apikey": SB_KEY, "User-Agent": "myc-export"})  # noqa: S310 – stały adres https
    return json.loads(urllib.request.urlopen(req, timeout=60).read())  # noqa: S310 – stały adres https


def examples(rows: list[dict]) -> list[tuple[str, str]]:
    seen, out = set(), []
    for r in rows:
        q, a = PROMPT[r["kind"]].format(p=r["prompt"]), r["target"]
        if (q, a) not in seen and q.strip() and a.strip():
            seen.add((q, a))
            out.append((q, a))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--name", default="sft-speaker-0001.bin.gz")
    ap.add_argument("--min", type=int, default=50)
    ap.add_argument("--t", type=int, default=96)
    a = ap.parse_args()
    rows = fetch()
    ex = examples(rows)
    if len(ex) < a.min:
        print(json.dumps({"consensus_rows": len(rows), "examples": len(ex), "min": a.min, "shard": None}))
        return
    import torch
    from export_lm_data import chat
    from tokenizers import Tokenizer

    from iot_mycelium.mesh import lm, selfplay

    tok = Tokenizer.from_file(a.tokenizer)
    _, eids, emask, _ = lm.unpack_data((DATA / "eval.bin").read_bytes())
    gate = [tok.decode(rw[m].tolist()) for rw, m in zip(eids, emask, strict=True)]
    gate_hash = {selfplay.qhash(t) for t in gate}
    gate_ng = set().union(*(selfplay.ngrams(t, 8) for t in gate))
    clean = [x for x in ex if selfplay.qhash(x[0]) not in gate_hash and not (selfplay.ngrams(x[0], 8) & gate_ng)]
    ids, mask = [], []
    for q, ans in clean:
        c = chat(tok, q, "", ans, True, a.t)
        if c:
            ids.append(c[0])
            mask.append(c[1])
    meta = json.loads((DATA / "meta.json").read_text())
    info = {
        "kind": "sft-speaker",
        "source": "czat globalny: konsensus ludzi pod wpisami Grzybni AI (myc_speaker_sft, tylko osoby z włączoną nauką)",
        "gate_eval_sha": meta["eval"]["sha256"],
        "license": "wkład użytkowników czatu (konsensus), bez danych osobowych",
    }
    b = gzip.compress(lm.pack_data(info, torch.tensor(ids), torch.tensor(mask)), 6, mtime=0)
    (DATA / a.name).write_bytes(b)
    entry = {"name": a.name, "sha256": lm.sha256(b), "bytes": len(b), "n": len(ids), "rows_in": len(rows), **info}
    meta["sft"] = [f for f in meta.get("sft", []) if f["name"] != a.name] + [entry]
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps(entry, ensure_ascii=False))


if __name__ == "__main__":
    main()
