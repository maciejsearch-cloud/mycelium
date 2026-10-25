"""Logity nauczyciela do destylacji modelu językowego grzybni (uruchamiane na boxie, nie na węzłach ochotników).

Nauczyciel: Qwen/Qwen2.5-1.5B-Instruct (Apache-2.0, ten sam tokenizer co uczeń Qwen2.5-0.5B-Instruct). Dla każdego
odłamka treningowego z web/public/data/lm liczy przód nauczyciela na tych samych tokenach i zapisuje top-k surowych
logitów (k=32, fp16) dla każdej liczonej pozycji (mask[:,1:]) w formacie danych MYCKD1 (bez pickle), gzip.
Pliki + kd.json (sumy SHA-256, licencja, rewizja, perpleksja nauczyciela na odłamku) trafiają do wydania lm-kd-1
w repozytorium demo. Wznawialne: odłamki już opisane w kd.json są pomijane. Odłamek walidacyjny (ostatni) – nigdy.

Użycie: python scripts/export_kd_shards.py --out /workspace/projects/myc-kd --max 400 [--upload]
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import random
import subprocess
import sys
import time
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from iot_mycelium.mesh import lm  # noqa: E402

TEACHER = "Qwen/Qwen2.5-1.5B-Instruct"
REPO = "maciejsearch-cloud/demo"
TAG = "lm-kd-1"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/workspace/projects/myc-kd")
    ap.add_argument("--max", type=int, default=400)
    ap.add_argument("--k", type=int, default=32)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--revision", required=True)
    ap.add_argument("--upload", action="store_true")
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    from transformers import AutoModelForCausalLM

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    data = ROOT / "web" / "public" / "data" / "lm"
    meta = json.loads((data / "meta.json").read_text())
    n = int(meta["shards"]) - 1  # ostatni = walidacja agregatora
    order = list(range(n))
    random.Random(20261024).shuffle(order)  # stała kolejność, równomierne pokrycie
    kp = out / "kd.json"
    kd = (
        json.loads(kp.read_text())
        if kp.exists()
        else {
            "teacher": f"{TEACHER}@{a.revision}",
            "teacher_license": "Apache-2.0 (https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct/blob/main/LICENSE)",
            "student": "Qwen/Qwen2.5-0.5B-Instruct + LoRA r4",
            "data": meta["source"],
            "data_license": meta["license"],
            "format": "MYCKD1: magic(8) + u32 len + JSON + int32 idx[P×k] + fp16 logits[P×k]; gzip",
            "k": a.k,
            "T": lm.KD_T,
            "alpha": lm.KD_ALPHA,
            "files": [],
        }
    )
    done = {f["shard"] for f in kd["files"]}
    model = AutoModelForCausalLM.from_pretrained(TEACHER, revision=a.revision, dtype=torch.bfloat16)
    model.eval()
    for s in order[: a.max]:
        if s in done:
            continue
        f = meta["files"][s]
        raw = (data / f["name"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == f["sha256"]
        _, ids, mask, _ = lm.unpack_data(gzip.decompress(raw))
        t0 = time.time()
        ix_all, lg_all, nll, cnt = [], [], 0.0, 0
        with torch.no_grad():
            for i in range(0, ids.shape[0], a.batch):
                x, m = ids[i : i + a.batch], mask[i : i + a.batch]
                z = model(input_ids=x).logits[:, :-1][m[:, 1:]].float()
                y = x[:, 1:][m[:, 1:]]
                nll += float(torch.nn.functional.cross_entropy(z, y, reduction="sum"))
                cnt += int(y.numel())
                v, ix = z.topk(a.k, -1)
                ix_all.append(ix.to(torch.int32))
                lg_all.append(v.to(torch.float16))
        idx, lg = torch.cat(ix_all), torch.cat(lg_all)
        assert idx.shape[0] == int(lm.kd_offsets(mask)[-1])
        b = gzip.compress(lm.pack_kd({"shard": s, "train_sha256": f["sha256"], "teacher": kd["teacher"]}, idx, lg), 6)
        name = f"kd-{s:04d}.bin.gz"
        (out / name).write_bytes(b)
        kd["files"].append(
            {
                "shard": s,
                "name": name,
                "sha256": hashlib.sha256(b).hexdigest(),
                "bytes": len(b),
                "train_sha256": f["sha256"],
                "positions": int(idx.shape[0]),
                "teacher_ppl": round(math.exp(nll / max(1, cnt)), 4),
            }
        )
        kd["updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        kp.write_text(json.dumps(kd, ensure_ascii=False, indent=1))
        print(
            f"odłamek {s}: {idx.shape[0]} pozycji, ppl nauczyciela {kd['files'][-1]['teacher_ppl']}, "
            f"{len(b) / 1e6:.1f} MB, {time.time() - t0:.0f} s",
            flush=True,
        )
        if a.upload:
            for p in (out / name, kp):
                subprocess.run(["gh", "release", "upload", TAG, str(p), "--clobber", "-R", REPO], check=True)


if __name__ == "__main__":
    main()
