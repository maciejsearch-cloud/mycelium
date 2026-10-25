"""Dane modelu językowego grzybni z polskiej Wikipedii (wikimedia/wikipedia 20231101.pl, CC BY-SA 4.0).

Podział po haśle (sha1 tytułu): 1% haseł wyłącznie do zbioru testowego, reszta do treningu – ten sam tekst
nigdy nie trafia do obu. Wynik (web/public/data/lm/, publikowany na stronie demo):
  train-NNNN.bin  – odłamki treningowe: 50% akapitów (strata na całym tekście) i 50% rozmów
                    „Co to jest X?” → „X to …” z pierwszego zdania hasła (strata tylko na odpowiedzi),
  eval.bin        – stały zbiór testowy: 192 akapity do perpleksji + 2000 pytań wyboru definicji (1 z 4),
  meta.json       – liczba odłamków, sumy SHA-256, źródło i licencja.
Użycie: python scripts/export_lm_data.py --parquet plwiki0.parquet plwiki5.parquet --tokenizer tokenizer.json \
         --eval-parquet plwiki1.parquet plwiki2.parquet plwiki3.parquet plwiki4.parquet --eval-only
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import random
import re
import sys
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from iot_mycelium.mesh.lm import pack_data, sha256  # noqa: E402

OUT = ROOT / "web" / "public" / "data" / "lm"
SYS = (
    "Jesteś Mycelium AI, pomocnym asystentem działającym na grzybni przeglądarek wolontariuszy. "
    "Odpowiadaj po polsku, krótko i życzliwie.  Jeśli nie masz pewności, powiedz to."
)
QUESTIONS = ["Co to jest {n}?", "Czym jest {n}?", "Wyjaśnij krótko, czym jest {n}.", "Co oznacza {n}?"]
PAD = 151643
T_TRAIN, T_EVAL = 128, 80
SEQ_PER_SHARD = 256
EVAL_VERSION = 2


def bucket(title: str) -> int:
    return int(hashlib.sha1(title.encode(), usedforsecurity=False).hexdigest()[:6], 16) % 1000


def lead(title: str, text: str) -> tuple[str, str] | None:
    """('Jeż', 'rodzaj ssaka …') z pierwszego akapitu „Jeż (Erinaceus) – rodzaj ssaka …”."""
    first = text.strip().split("\n", 1)[0]
    m = re.match(r"^(.{1,80}?)\s+[–—-]\s+(.{25,})$", first)
    if not m:
        return None
    name = re.sub(r"\s*\(.*?\)", "", m.group(1)).strip()
    base = re.sub(r"\s*\(.*?\)$", "", title).strip()
    if not name or name.lower() != base.lower():
        return None
    d = re.sub(r"\s*\[[^\]]*\]", "", m.group(2)).strip()
    # pierwsze zdanie (bez cięcia na skrótach typu „m.in.”, „ur.”), maks. 160 znaków na granicy słowa
    s = re.split(r"(?<=[a-ząćęłńóśźż0-9\)]{3})\. (?=[A-ZĄĆĘŁŃÓŚŹŻ])", d, maxsplit=1)[0].rstrip(".")
    if len(s) > 160:
        s = s[:160].rsplit(" ", 1)[0].rstrip(",;:")
    if len(s) < 25 or "\n" in s:
        return None
    return name, s


def paragraphs(text: str) -> list[str]:
    return [p.strip() for p in text.split("\n") if len(p.strip()) >= 250 and not p.strip().endswith(":")]


def chat(tok, q: str, prefix: str, ans: str, sys_prompt: bool, T: int):
    head = (f"<|im_start|>system\n{SYS}<|im_end|>\n" if sys_prompt else "") + (
        f"<|im_start|>user\n{q}<|im_end|>\n<|im_start|>assistant\n{prefix}"
    )
    a = tok.encode(head).ids
    b = tok.encode(ans + ("<|im_end|>" if sys_prompt else "")).ids
    ids = a + b
    if len(ids) > T:
        return None
    return ids + [PAD] * (T - len(ids)), [0] * len(a) + [1] * len(b) + [0] * (T - len(ids))


def para(tok, p: str, T: int):
    ids = tok.encode(p).ids[:T]
    if len(ids) < T:
        return None
    return ids, [1] * T


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", nargs="+", required=True)
    ap.add_argument(
        "--eval-parquet",
        nargs="*",
        default=[],
        help="dodatkowe pliki tego samego zrzutu: z nich biorą się WYŁĄCZNIE hasła testowe (ten sam podział sha1)",
    )
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--shards", type=int, default=400)
    ap.add_argument("--n-ppl", type=int, default=192)
    ap.add_argument("--n-mc", type=int, default=2000)
    ap.add_argument(
        "--eval-only",
        action="store_true",
        help="przebuduj tylko eval.bin (odłamki treningowe i ich sumy w meta.json bez zmian)",
    )
    a = ap.parse_args()
    import pyarrow.parquet as pq
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(a.tokenizer)
    rng = random.Random(20261019)
    train_qa, train_p, ev_leads, ev_p = [], [], [], []
    need = a.shards * SEQ_PER_SHARD // 2
    for f in [*a.parquet, *a.eval_parquet]:
        only_eval = f in a.eval_parquet
        t = pq.read_table(f, columns=["title", "text"])
        for title, text in zip(t.column("title").to_pylist(), t.column("text").to_pylist(), strict=True):
            if len(text) < 1500:
                continue
            ev = bucket(title) < 10
            if only_eval and not ev:
                continue
            ld = lead(title, text)
            ps = paragraphs(text)[1:4]  # pomijamy pierwszy akapit (jest w pytaniu o definicję)
            if ev:
                if ld:
                    ev_leads.append(ld)
                if not only_eval:  # akapity perpleksji bez zmian (te same 192 co w wersji 1)
                    ev_p.extend(ps[:1])
            else:
                if ld and len(train_qa) < need * 3:
                    train_qa.append(ld)
                if len(train_p) < need * 3:
                    train_p.extend(ps[:1])
    print(
        f"hasła: trening QA {len(train_qa)}, akapity {len(train_p)}; test: definicje {len(ev_leads)}, akapity {len(ev_p)}"
    )
    rng.shuffle(train_qa)
    rng.shuffle(train_p)
    OUT.mkdir(parents=True, exist_ok=True)
    if not a.eval_only:
        for old in OUT.glob("train-*.bin*"):
            old.unlink()
    # trening
    seqs = []
    qi = pi = 0
    while len(seqs) < a.shards * SEQ_PER_SHARD and (qi < len(train_qa) or pi < len(train_p)):
        if len(seqs) % 2 == 0 and qi < len(train_qa):
            n, d = train_qa[qi]
            qi += 1
            r = chat(tok, QUESTIONS[qi % len(QUESTIONS)].format(n=n), "", f"{n} to {d}.", True, T_TRAIN)
        elif pi < len(train_p):
            r = para(tok, train_p[pi], T_TRAIN)
            pi += 1
        else:
            qi = len(train_qa)
            continue
        if r:
            seqs.append(r)
    n_sh = len(seqs) // SEQ_PER_SHARD
    files = []
    for s in range(0 if a.eval_only else n_sh):
        part = seqs[s * SEQ_PER_SHARD : (s + 1) * SEQ_PER_SHARD]
        ids = torch.tensor([x[0] for x in part], dtype=torch.int32)
        mask = torch.tensor([x[1] for x in part], dtype=torch.uint8)
        b = pack_data({"kind": "train", "shard": s, "t": T_TRAIN}, ids, mask)
        name = f"train-{s:04d}.bin.gz"
        b = gzip.compress(b, 9, mtime=0)
        (OUT / name).write_bytes(b)
        files.append({"name": name, "sha256": sha256(b), "bytes": len(b)})
    # test: akapity (perpleksja) + definicje (wybór 1 z 4, dystraktory = definicje innych haseł testowych)
    rows, mask_rows = [], []
    for p in ev_p:
        r = para(tok, p, T_EVAL)
        if r:
            rows.append(r[0])
            mask_rows.append(r[1])
        if len(rows) == a.n_ppl:
            break
    n_ppl = len(rows)
    mc = []
    pool = [ld for ld in ev_leads]
    rng.shuffle(pool)
    for i, (n, d) in enumerate(pool):
        if len(mc) == a.n_mc:
            break
        others = [pool[(i + k) % len(pool)][1] for k in (101, 211, 307)]
        opts = [x if len(x) <= 120 else x[:120].rsplit(" ", 1)[0].rstrip(",;:") for x in (d, *others)]
        ans = rng.randrange(4)
        opts[0], opts[ans] = opts[ans], opts[0]
        enc = [chat(tok, f"Co to jest {n}?", f"{n} to ", f"{o}.", False, T_EVAL) for o in opts]
        if any(e is None for e in enc):
            continue
        idx = []
        for e in enc:
            idx.append(len(rows))
            rows.append(e[0])
            mask_rows.append(e[1])
        mc.append([idx, ans])
    ids = torch.tensor(rows, dtype=torch.int32)
    mask = torch.tensor(mask_rows, dtype=torch.uint8)
    eb = pack_data({"kind": "eval", "n_ppl": n_ppl, "n_mc": len(mc), "t": T_EVAL}, ids, mask, json.dumps(mc).encode())
    (OUT / "eval.bin").write_bytes(eb)
    if a.eval_only:
        old = json.loads((OUT / "meta.json").read_text())
        files = old["files"]
        assert old["shards"] == n_sh, "odłamki treningowe różnią się od opublikowanych"
    meta = {
        "source": "wikimedia/wikipedia 20231101.pl (Polska Wikipedia)",
        "license": "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); tekst: autorzy Wikipedii",
        "parquet_sha256": [hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in a.parquet],
        "eval_parquet_sha256": [hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in a.eval_parquet],
        "tokenizer": "Qwen/Qwen2.5-0.5B-Instruct@7ae557604adf67be50417f59c2c2f167def9a775",
        "split": "sha1(tytuł) % 1000 < 10 → tylko test",
        "shards": n_sh,
        "compression": "gzip (odłamki treningowe)",
        "seq_per_shard": SEQ_PER_SHARD,
        "t_train": T_TRAIN,
        "files": files,
        "eval": {
            "name": "eval.bin",
            "sha256": sha256(eb),
            "bytes": len(eb),
            "n_ppl": n_ppl,
            "n_mc": len(mc),
            "t": T_EVAL,
            # wersja zbioru: 1 = 250 pytań (19.10.2026), 2 = 2000 pytań (24.10.2026; pierwsze 250 = wersja 1)
            "version": EVAL_VERSION,
        },
        "system_prompt": SYS,
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(f"odłamki: {n_sh} × {SEQ_PER_SHARD}; test: {n_ppl} akapitów, {len(mc)} pytań; sha {meta['eval']['sha256']}")
    print("przykład:", tok.decode(seqs[0][0]).replace("\n", " / ")[:400])
    print("przykład testu:", tok.decode(rows[n_ppl]).replace("\n", " / "), "| poprawna:", mc[0][1])


if __name__ == "__main__":
    main()
